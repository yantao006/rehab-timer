'use strict';
// Executes the shipped store script with in-memory storage and a scripted fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script id="rehab-store">([\s\S]*?)<\/script>/g)][0][1];
const A = 'five-stage-v1', B = 'lower-limb-joints-v1';
const plain = value => JSON.parse(JSON.stringify(value));

class MemoryStorage {
  constructor(entries = {}) { this.data = new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
function server({ records = [], fail = false } = {}) {
  const stored = new Map(records.map(r => [`${r.program}:${r.id}`, { revoked: false, revokedAt: null, ...r }]));
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (fail) throw new TypeError('offline');
    const reply = (status, data) => ({ status, json: async () => data });
    if (url === '/api/records' && init.method === 'GET') return reply(200, { ok: true, records: [...stored.values()] });
    if (url === '/api/records' && init.method === 'POST') {
      const record = JSON.parse(init.body).record, key = `${record.program}:${record.id}`;
      const existing = stored.get(key);
      if (existing && existing.date !== record.date) return reply(409, { ok: false });
      const { version, ...value } = record;
      if (!existing) stored.set(key, { ...value, revoked: false, revokedAt: null });
      return reply(200, { ok: true, record: stored.get(key) });
    }
    if (url === '/api/records/revoke') {
      const { program, id } = JSON.parse(init.body), key = `${program}:${id}`;
      if (!stored.has(key)) return reply(404, { ok: false });
      stored.set(key, { ...stored.get(key), revoked: true, revokedAt: '2026-10-31T00:00:00.000Z' });
      return reply(200, { ok: true, record: stored.get(key) });
    }
    return reply(404, { ok: false });
  }
  return { fetch, calls, stored, set fail(value) { fail = value; } };
}
function load(options) {
  const context = vm.createContext({ Intl, JSON, Date, Promise, setTimeout, clearTimeout, AbortController, crypto: { randomUUID: () => 'synthetic-uuid-0001' } });
  vm.runInContext(source, context);
  let n = 0;
  return context.RehabStore.create({ now: () => 1_700_000_000_000 + (n++), uuid: () => `synthetic-uuid-${String(n++).padStart(4, '0')}`, ...options });
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const record = (id, date = '2026-10-30', program = A) => ({ version: 1, id, program, date, finishedAt: `${date}T10:00:00.000Z`, source: 'training', timeZone: 'Asia/Shanghai' });

test('测试模式只写本机隔离空间，从不请求接口', async () => {
  const storage = new MemoryStorage(), api = server();
  const store = load({ storage, isolated: true, fetch: api.fetch });
  await store.init();
  assert.equal(store.complete(record('synthetic-session-0001')), true);
  await settle();
  assert.equal(api.calls.length, 0);
  assert.equal(store.list().length, 1);
  assert.ok([...storage.data.keys()].every(k => k.startsWith('rehab:test:v3:')));
});

test('完成记录先写本机，断网保留，联网后静默上传且不重复', async () => {
  const storage = new MemoryStorage(), api = server();
  const store = load({ storage, isolated: false, fetch: api.fetch });
  api.fail = true;
  store.complete(record('synthetic-session-0002'));
  await store.flush();
  assert.equal(store.pending(), 1);
  assert.equal(store.list().length, 1, '断网时日历里已经能看到');
  api.fail = false;
  const before = api.calls.length;
  await store.flush();
  await store.flush();
  assert.equal(store.pending(), 0);
  assert.equal(api.calls.slice(before).filter(c => c.method === 'POST').length, 1, '恢复联网后只上传一次');
  assert.equal(api.stored.size, 1);
  await store.refresh();
  assert.equal(store.list().length, 1);
});

test('刷新时以服务端为准，并叠加尚未上传的本机改动', async () => {
  const storage = new MemoryStorage(), api = server({ records: [{ ...record('synthetic-server-0001', '2026-10-28'), version: undefined }] });
  const store = load({ storage, isolated: false, fetch: api.fetch });
  await store.refresh();
  api.fail = true;
  store.complete(record('synthetic-session-0003', '2026-10-31'));
  store.revoke(A, 'synthetic-server-0001');
  api.fail = false;
  await store.refresh();
  assert.deepEqual(plain(store.list().map(r => r.id)), ['synthetic-session-0003']);
  await store.flush();
  assert.equal(api.stored.get(`${A}:synthetic-server-0001`).revoked, true);
  assert.equal(store.pending(), 0);
});

test('补记不能是未来日期，也不伪造完成时间；撤销只针对一条', async () => {
  const storage = new MemoryStorage(), api = server();
  const store = load({ storage, isolated: false, fetch: api.fetch });
  assert.equal(store.addManual(A, '2026-11-02', '2026-10-31'), false);
  assert.equal(store.addManual(B, '2026-10-29', '2026-10-31'), true);
  store.complete(record('synthetic-session-0004', '2026-10-29', B));
  await store.flush();
  const manual = [...api.stored.values()].find(r => r.source === 'manual');
  assert.equal(manual.finishedAt, null);
  store.revoke(B, manual.id);
  await store.flush();
  assert.deepEqual(plain(store.list(B).map(r => r.id)), ['synthetic-session-0004']);
});

test('上一版本的待上传完成、补记和撤销会自动带过来，界面无需操作', async () => {
  const storage = new MemoryStorage({
    'rehab-timer:v2:record:five-stage-v1:synthetic-old-0001': { id: 'synthetic-old-0001', program: A, date: '2026-10-20', finishedAt: '2026-10-20T09:00:00.000Z', source: 'training', timeZone: null, revoked: false },
    'rehab-timer:v2:op:op-1': { id: 'op-1', type: 'complete', program: A, sessionId: 'synthetic-old-0002', payload: { program: A, sessionId: 'synthetic-old-0002', record: { version: 1, id: 'synthetic-old-0002', program: A, date: '2026-10-21', finishedAt: '2026-10-21T09:00:00.000Z', source: 'training', timeZone: 'Asia/Shanghai' } } },
    'rehab-timer:v2:op:op-2': { id: 'op-2', type: 'manual', program: B, payload: { program: B, record: { version: 1, id: 'manual-synthetic-0003', program: B, date: '2026-10-22', finishedAt: null, source: 'manual', timeZone: null } } },
    'rehab-timer:v2:op:op-3': { id: 'op-3', type: 'revoke', program: A, payload: { program: A, recordId: 'synthetic-old-0001' } },
    'rehab-timer:v2:op:op-4': { id: 'op-4', type: 'progress', program: A, payload: {} }
  });
  const api = server({ records: [{ ...record('synthetic-old-0001', '2026-10-20'), finishedAt: '2026-10-20T09:00:00.000Z' }] });
  const store = load({ storage, isolated: false, fetch: api.fetch });
  await store.init();
  await store.flush();
  assert.equal(store.pending(), 0);
  assert.ok(api.stored.has(`${A}:synthetic-old-0002`));
  assert.ok(api.stored.has(`${B}:manual-synthetic-0003`));
  assert.equal(api.stored.get(`${A}:synthetic-old-0001`).revoked, true);
  assert.ok(storage.getItem('rehab-timer:v2:op:op-1'), '原始数据保留');
  const again = load({ storage, isolated: false, fetch: api.fetch });
  await again.init();
  assert.equal(again.pending(), 0, '只迁移一次');
});

test('最初的本机历史只读原始键：被取消的日期不导入，补记只在当天没有记录时生成', async () => {
  const storage = new MemoryStorage({
    'rehab-timer:v1:done:synthetic-v1-0001': { version: 1, id: 'synthetic-v1-0001', date: '2026-09-01', finishedAt: '2026-09-01T10:00:00.000Z' },
    'rehab-timer:v1:done:synthetic-v1-0002': { version: 1, id: 'synthetic-v1-0002', date: '2026-09-02', finishedAt: '2026-09-02T10:00:00.000Z' },
    'rehab-timer:v1:date:2026-09-02': false,
    'rehab-timer:v1:date:2026-09-03': true,
    'rehab-timer:v1:date:2026-09-01': true,
    'rehab-timer:v1:joint:done:synthetic-v1-0003': { version: 1, id: 'synthetic-v1-0003', date: '2026-09-04', finishedAt: '2026-09-04T10:00:00.000Z' },
    'rehab-timer:test:v1:100:done:synthetic-test-0001': { version: 1, id: 'synthetic-test-0001', date: '2026-09-05', finishedAt: '2026-09-05T10:00:00.000Z' }
  });
  const api = server();
  const store = load({ storage, isolated: false, fetch: api.fetch });
  await store.init();
  await store.flush();
  const ids = [...api.stored.values()].map(r => `${r.program === A ? 'a' : 'b'}:${r.date}:${r.source}`).sort();
  assert.deepEqual(ids, ['a:2026-09-01:legacy', 'a:2026-09-03:manual', 'b:2026-09-04:legacy']);
  const again = load({ storage, isolated: false, fetch: api.fetch });
  await again.init(); await again.flush();
  assert.equal(api.stored.size, 3, '重复打开不会重复导入');
});

test('偏好和进度按计划分别保存；坏数据不会让页面出错', () => {
  const storage = new MemoryStorage({ 'rehab:v3:prefs': '{broken' });
  const store = load({ storage, isolated: false, fetch: null });
  assert.deepEqual(plain(store.prefs()), { groupRest: 60, sound: true });
  store.setPrefs({ groupRest: 120 });
  store.setPrefs({ sound: false });
  assert.deepEqual(plain(store.prefs()), { groupRest: 120, sound: false });
  store.saveProgress(A, { version: 3, plan: A });
  assert.equal(store.progress(A).plan, A);
  assert.equal(store.progress(B), null);
  store.clearProgress(A);
  assert.equal(store.progress(A), null);
});
