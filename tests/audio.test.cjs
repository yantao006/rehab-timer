'use strict';
// Runs the shipped audio script with a scripted fetch and a fake decoder to check the loading rules:
// a stalled download fails instead of hanging, a compressed copy of the wrong length is rejected
// in favour of the WAV, and a failed load can be retried.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script id="rehab-audio">([\s\S]*?)<\/script>/g)][0][1];

function load({ fetch, lengths }) {
  class FakeContext {
    constructor() { this.sampleRate = 22050; }
    // The decoded length of a source is its byte length, so a test can pick it by choosing the payload size.
    decodeAudioData(data) { return Promise.resolve({ length: lengths ? lengths(data.byteLength) : data.byteLength }); }
  }
  const context = vm.createContext({ globalThis: null, fetch, OfflineAudioContext: FakeContext, Blob, URL, AbortController, setTimeout, clearTimeout, Promise, Math, Number, Error, Uint8Array });
  context.globalThis = context;
  vm.runInContext(source, context);
  return context.RehabAudio;
}
const reply = (bytes, { chunks = 1 } = {}) => {
  const data = new Uint8Array(bytes);
  const size = Math.ceil(data.length / chunks);
  let at = 0;
  return { ok: true, status: 200, headers: { get: name => name === 'content-length' ? String(data.length) : null }, body: { getReader: () => ({ read: async () => at >= data.length ? { done: true } : { done: false, value: data.slice(at, (at += size)) } }) } };
};
// A request that never answers, but honours abort like the real fetch.
const stall = (url, init = {}) => new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));

test('下载卡住时按停滞时间报错，而不是一直等；之后可以重试', async () => {
  let healthy = false;
  const audio = load({ fetch: (url, init) => healthy ? Promise.resolve(reply(1000)) : stall(url, init) });
  const started = Date.now();
  await assert.rejects(audio.load('voice.wav', { stallMs: 60 }), /aborted/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(audio.ready(), false);
  healthy = true;
  await audio.load('voice.wav', { stallMs: 60 });
  assert.equal(audio.ready(), true);
});

test('只要还有数据到达就不算卡住，并报告下载进度', async () => {
  const seen = [];
  const audio = load({ fetch: async () => reply(900, { chunks: 3 }) });
  await audio.load('voice.wav', { stallMs: 60, onProgress: (bytes, total) => seen.push([bytes, total]) });
  assert.deepEqual(seen, [[300, 900], [600, 900], [900, 900]]);
});

test('压缩副本解码长度对不上时改用 WAV；对得上就只下载压缩副本', async () => {
  const calls = [];
  const fetch = async url => { calls.push(url); return reply(url.endsWith('.m4a') ? 700 : 5000); };
  let audio = load({ fetch });
  await audio.load(['voice.m4a', 'voice.wav'], { samples: 5000 });
  assert.deepEqual(calls, ['voice.m4a', 'voice.wav'], '长度不符，退回 WAV');

  calls.length = 0;
  audio = load({ fetch });
  await audio.load(['voice.m4a', 'voice.wav'], { samples: 700 });
  assert.deepEqual(calls, ['voice.m4a'], '长度相符，不再下载 WAV');

  calls.length = 0;
  audio = load({ fetch });
  await assert.rejects(audio.load(['voice.m4a', 'voice.wav'], { samples: 99999 }), /length/);
  assert.deepEqual(calls, ['voice.m4a', 'voice.wav'], '两个来源都不合格才失败');
});

test('第一个来源下载失败时直接试下一个', async () => {
  const calls = [];
  const audio = load({ fetch: async url => { calls.push(url); return url.endsWith('.m4a') ? { ok: false, status: 404 } : reply(1000); } });
  await audio.load(['voice.m4a', 'voice.wav'], { samples: 1000 });
  assert.deepEqual(calls, ['voice.m4a', 'voice.wav']);
});
