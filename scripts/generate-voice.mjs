#!/usr/bin/env node
// Development-only: render every cue in RehabCore.VOICE_TEXT into one sprite, audio/voice.wav,
// plus audio/voice.json with each clip's offset and duration. The browser builds tracks from it.
//
//   node scripts/generate-voice.mjs                      # macOS `say` (default voice Tingting)
//   node scripts/generate-voice.mjs --voice Tingting --rate 180
//   node scripts/generate-voice.mjs --dir path/to/recordings   # <key>.wav|.m4a|.mp3 per cue
//
// Needs ffmpeg. Output: 22.05 kHz mono 16-bit PCM, loudness-normalised per clip.
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const RATE = 22050, GAP = 0.15;
const voiceName = option('voice', 'Tingting');
const sayRate = option('rate', '');
const recordings = option('dir', '');
const only = option('only', '');

const context = vm.createContext({ Date, Intl });
vm.runInContext(await readFile(path.join(root, 'src/core.js'), 'utf8'), context);
const texts = context.RehabCore.VOICE_TEXT;
const keys = Object.keys(texts);
const tmp = await mkdtemp(path.join(tmpdir(), 'rehab-voice-'));

// Trim silence, remove rumble, add a little presence for phone speakers, normalise loudness.
const FILTER = [
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02',
  'areverse', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.04', 'areverse',
  'highpass=f=90', 'equalizer=f=3000:t=q:w=1.2:g=3',
  'loudnorm=I=-16:TP=-1.5:LRA=7',
  'adelay=25', 'apad=pad_dur=0.04'
].join(',');

async function source(key) {
  if (recordings) {
    for (const ext of ['wav', 'm4a', 'mp3', 'aiff']) {
      const file = path.join(recordings, `${key}.${ext}`);
      try { await access(file); return file; } catch { /* try next */ }
    }
    throw new Error(`Missing recording for ${key} in ${recordings}`);
  }
  const file = path.join(tmp, `${key}.aiff`);
  const sayArgs = ['-v', voiceName, '-o', file];
  if (sayRate) sayArgs.push('-r', sayRate);
  execFileSync('say', [...sayArgs, texts[key]]);
  return file;
}

const pcm = [], clips = {};
let offset = 0;
for (const key of keys) {
  if (only && !only.split(',').includes(key)) continue;
  const input = await source(key);
  const raw = path.join(tmp, `${key}.raw`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-af', FILTER, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-acodec', 'pcm_s16le', raw]);
  const data = await readFile(raw);
  const samples = data.length / 2;
  if (samples < RATE * 0.12) throw new Error(`Clip too short or silent: ${key}`);
  clips[key] = [Math.round(offset / RATE * 1000), Math.round(samples / RATE * 1000)];
  pcm.push(data, Buffer.alloc(Math.round(GAP * RATE) * 2));
  offset += samples + Math.round(GAP * RATE);
  process.stdout.write(`${key} ${clips[key][1]}ms\n`);
}
const body = Buffer.concat(pcm);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + body.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(body.length, 40);
const wav = Buffer.concat([header, body]);
const version = createHash('sha256').update(wav).digest('hex').slice(0, 12);
await writeFile(path.join(root, 'audio/voice.wav'), wav);
const manifest = { version, rate: RATE, source: recordings ? `recordings:${path.basename(recordings)}` : `macOS say ${voiceName}${sayRate ? ` -r ${sayRate}` : ''}`, clips };
await writeFile(path.join(root, 'audio/voice.json'), JSON.stringify(manifest, null, 2) + '\n');
await rm(tmp, { recursive: true, force: true });
console.log(`audio/voice.wav ${(wav.length / 1048576).toFixed(2)} MB, ${Object.keys(clips).length} clips, version ${version}`);
