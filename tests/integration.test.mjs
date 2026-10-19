import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SQLiteD1 } from './helpers/d1-sqlite.mjs';
import { onRequest } from '../functions/api/[[path]].js';
import { stateResponse } from '../functions/_lib/storage.js';
const coreSource = readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
const repositorySource = readFileSync(new URL('../src/repository.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse('2026-09-07T10:00:00.000Z');
const environments = [], runtimes = [];
afterEach(() => { for (const f of runtimes.splice(0)) f.repo.destroy(); for (const env of environments.splice(0)) env.DB.close(); });
class Storage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
function environment() { const env = { DB: new SQLiteD1(), APP_ENV: 'preview', SESSION_SECRET: 'synthetic-persistent-server-secret-00000000000000000' }; environments.push(env); return env; }
function transport(env) {
  return {
    offline: false, drop: null, calls: [],
    async fetch(path, options = {}) {
      if (this.offline) throw new TypeError('Synthetic network disconnected');
      const data = options.body ? JSON.parse(options.body) : null;
      this.calls.push({ path, data: plain(data) });
      const headers = { ...options.headers, ...(options.method !== 'GET' ? { Origin: 'https://integration.example' } : {}), 'CF-Connecting-IP': '192.0.2.1' };
      const response = await onRequest({ env, request: new Request(`https://integration.example${path}`, { ...options, headers }) });
      assert.equal(response.headers.get('set-cookie'), null, 'The API must not require a session cookie.');
      if (data?.type === this.drop && response.ok) { this.drop = null; throw new TypeError('Synthetic response lost after committed transaction'); }
      return response;
    }
  };
}
function runtime(env, { storage = new Storage(), network = transport(env), search = '', protocol = 'https:' } = {}) {
  let clock = NOW;
  const context = vm.createContext({ Date, Intl, Promise, console, crypto, location: { protocol, search } });
  vm.runInContext(coreSource, context); vm.runInContext(repositorySource, context);
  const core = context.RehabCore;
  const repo = context.RehabPersistence.create({ mode: 'cloud', storage, fetch: network.fetch.bind(network), now: () => clock, uuid: () => crypto.randomUUID() });
  const f = { repo, core, storage, network, env, store: repo.forProgram(core.PROGRAM), advance(ms) { clock += ms; } };
  f.snapshot = (id = 'integration-session-001', program = core.PROGRAM, groupRestSeconds = 60) => { const engine = new core.Engine(1000, program, groupRestSeconds); engine.start(id); engine.arm(0); return plain(engine.snapshot()); };
  f.finish = (id = 'integration-session-001', program = core.PROGRAM) => ({ ...f.snapshot(id, program), index: core.programs[program].plan.length - 1, remaining: 0, state: 'finished', completion: { version: 1, id, date: core.localDate(new Date(NOW)), finishedAt: new Date(NOW).toISOString() } });
  runtimes.push(f); return f;
}
async function connected(env, options) {
  const f = runtime(env, options); await f.repo.init();
  assert.equal(f.repo.status().state, 'synced', f.repo.status().message); return f;
}
async function start(f, id = 'integration-session-001', program = f.core.PROGRAM) {
  assert.equal(f.repo.forProgram(program).saveProgress(f.snapshot(id, program)), true);
  await f.repo.flush(); assert.equal(f.repo.status().pending, 0, JSON.stringify(f.repo.status()));
}
function finish(f, id = 'integration-session-001', program = f.core.PROGRAM) {
  const store = f.repo.forProgram(program), value = f.finish(id, program);
  assert.equal(store.saveProgress(value, true), true); assert.equal(store.complete(value.completion), true); assert.equal(store.saveProgress(null), true);
}

test('真实仓储和SQLite：150秒组间休息在丢失响应、刷新和跨设备接管后保留', async () => {
  const env = environment(), first = await connected(env);
  for (const program of [first.core.PROGRAM, first.core.JOINT_PROGRAM]) {
    const id = `custom-rest-${program}`, store = first.repo.forProgram(program), snapshot = first.snapshot(id, program, 150);
    assert.equal(store.saveProgress(snapshot), true); await first.repo.flush();
    Object.assign(snapshot, { index: first.core.planFor(program, 150).findIndex(item => item.kind === 'group-rest'), remaining: 148765, state: 'paused' });
    first.network.drop = 'progress'; assert.equal(store.saveProgress(snapshot, true), true); await first.repo.flush();
    assert.equal(first.repo.status().state, 'offline');
    const sent = first.network.calls.filter(call => call.data?.type === 'progress').at(-1).data;
    const reload = await connected(env, { storage: first.storage, network: first.network });
    assert.deepEqual(first.network.calls.filter(call => call.data?.type === 'progress').at(-1).data, sent);
    assert.equal(reload.repo.forProgram(program).loadProgress().groupRestSeconds, 150);
    const other = await connected(env), claimed = await other.repo.claimSession(id, program);
    assert.equal(claimed.groupRestSeconds, 150); assert.equal(claimed.remaining, 148765); assert.equal(claimed.state, 'paused');
    const restored = new other.core.Engine(1000, program, 60); assert.equal(restored.restore(claimed), true);
    assert.equal(restored.interval.seconds, 150); assert.equal(restored.snapshot().groupRestSeconds, 150);
    assert.equal(other.repo.forProgram(program).saveProgress({ ...claimed, remaining: 140000 }, true), true); await other.repo.flush();
    const session = (await stateResponse(env)).sessions.find(item => item.id === id);
    assert.equal(session.snapshot.groupRestSeconds, 150); assert.equal(session.snapshot.remaining, 140000); assert.equal(session.writerEpoch, 2);
    await first.repo.init();
  }
});

test('真实迁移保留自选组间休息，旧数据缺省60秒，备份原键不改写', async () => {
  const env = environment(), f = await connected(env);
  const chosen = f.snapshot('migrate-rest-selected', f.core.PROGRAM, 150);
  Object.assign(chosen, { index: f.core.planFor(f.core.PROGRAM, 150).findIndex(item => item.kind === 'group-rest'), remaining: 123456, state: 'paused' });
  const old = f.snapshot('migrate-rest-legacy', f.core.JOINT_PROGRAM); delete old.groupRestSeconds;
  f.storage.setItem('rehab-timer:v1:progress', JSON.stringify(chosen)); f.storage.setItem('rehab-timer:v1:joint:progress', JSON.stringify(old));
  const preview = f.repo.scanLegacy(); assert.equal(preview.counts.issues, 0); assert.equal(preview.counts.progress, 2);
  assert.equal((await f.repo.importLegacy(preview)).ok, true);
  const state = await stateResponse(env), selected = state.sessions.find(item => item.id === chosen.id), legacy = state.sessions.find(item => item.id === old.id);
  assert.equal(selected.snapshot.groupRestSeconds, 150); assert.equal(selected.snapshot.remaining, 123456); assert.equal(legacy.snapshot.groupRestSeconds, 60);
  assert.equal(f.store.loadProgress().groupRestSeconds, 150); assert.equal(f.repo.forProgram(f.core.JOINT_PROGRAM).loadProgress().groupRestSeconds, 60);
  assert.equal(f.storage.getItem('rehab-timer:v1:progress'), JSON.stringify(chosen)); assert.equal(f.storage.getItem('rehab-timer:v1:joint:progress'), JSON.stringify(old));
});

test('实际仓储/API/SQLite：无需口令或Cookie完成create/progress/complete和两计划共享日历', async () => {
  const env = environment(), f = await connected(env);
  await start(f); f.advance(10000); f.store.saveProgress({ ...f.snapshot(), remaining: 20000 }); await f.repo.flush();
  finish(f); await f.repo.flush();
  await start(f, 'integration-joint-001', f.core.JOINT_PROGRAM); finish(f, 'integration-joint-001', f.core.JOINT_PROGRAM); await f.repo.flush();
  assert.equal(f.repo.status().state, 'synced'); assert.equal(f.repo.isSynced(f.core.PROGRAM, 'integration-session-001'), true);
  const state = await stateResponse(env); assert.equal(state.records.length, 2); assert.ok(state.sessions.every(s => s.status === 'completed'));
  const other = await connected(env); assert.equal(other.store.history().length, 1); assert.equal(other.repo.forProgram(f.core.JOINT_PROGRAM).history().length, 1);
  assert.equal(other.store.loadProgress(), null, 'Other devices do not automatically resume a session.');
});

test('真实事务已完成后响应丢失，刷新继续使用同请求安全重试', async () => {
  const env = environment(), f = await connected(env); await start(f);
  f.network.drop = 'complete'; finish(f); await f.repo.flush();
  assert.equal(f.repo.status().state, 'offline'); assert.equal((await stateResponse(env)).records.length, 1);
  const sent = f.network.calls.filter(call => call.data?.type === 'complete').at(-1).data;
  const reload = await connected(env, { storage: f.storage, network: f.network });
  assert.equal(reload.repo.status().pending, 0); assert.equal((await stateResponse(env)).records.length, 1);
  assert.deepEqual(f.network.calls.filter(call => call.data?.type === 'complete').at(-1).data, sent);
});

test('断网完成后刷新保留待同步数据，重连补传原完成日期', async () => {
  const env = environment(), f = await connected(env); await start(f);
  f.network.offline = true; finish(f); await f.repo.flush();
  const reload = runtime(env, { storage: f.storage, network: f.network }); await reload.repo.init();
  assert.equal(reload.store.history().length, 1); assert.equal(reload.repo.status().state, 'offline'); assert.equal((await stateResponse(env)).records.length, 0);
  f.network.offline = false; await reload.repo.init();
  assert.equal(reload.repo.status().pending, 0); const record = (await stateResponse(env)).records[0];
  assert.equal(record.date, f.core.localDate(new Date(NOW))); assert.equal(record.finishedAt, new Date(NOW).toISOString());
});

test('显式接管后旧设备完成被拒绝，用户可保留本地完成为新的独立会话', async () => {
  const env = environment(), first = await connected(env); await start(first);
  first.network.offline = true;
  const second = await connected(env); const candidates = second.repo.sessions(); assert.equal(candidates.length, 1); assert.equal(second.store.loadProgress(), null);
  const recovered = await second.repo.claimSession(candidates[0].id, candidates[0].program); assert.equal(recovered.state, 'paused');
  finish(first); await first.repo.flush(); first.network.offline = false; await first.repo.init();
  const conflicts = first.repo.conflicts(); assert.equal(conflicts.length, 1); assert.equal(conflicts[0].code, 'writer_conflict');
  assert.equal((await stateResponse(env)).records.length, 0);
  await first.repo.resolveConflict(conflicts[0].id, 'copy');
  const state = await stateResponse(env); assert.equal(state.records.length, 1); assert.notEqual(state.records[0].id, candidates[0].id);
  assert.equal(state.sessions.find(s => s.id === candidates[0].id).writerEpoch, 2);
  assert.equal(first.repo.status().pending, 0);
});

test('真实迁移扫描原键、保留隐藏历史和未完进度，重复导入不重复，旧键不删除', async () => {
  const env = environment(), f = await connected(env), date = f.core.localDate(new Date(NOW));
  const completed = f.finish('legacy-integration-001').completion;
  f.storage.setItem(`rehab-timer:v1:done:${completed.id}`, JSON.stringify(completed));
  f.storage.setItem(`rehab-timer:v1:date:${date}`, 'false');
  f.storage.setItem('rehab-timer:v1:joint:progress', JSON.stringify(f.snapshot('legacy-joint-active', f.core.JOINT_PROGRAM)));
  f.storage.setItem('rehab-timer:test:v1:100:done:ignored-test-record', JSON.stringify({ ...completed, id: 'ignored-test-record' }));
  const preview = f.repo.scanLegacy(); assert.deepEqual(plain(preview.counts), { records: 1, overrides: 1, progress: 1, issues: 0 });
  const imported = await f.repo.importLegacy(preview); assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(f.store.history().length, 0); assert.equal((await stateResponse(env)).records.length, 1); assert.equal((await stateResponse(env)).records[0].revoked, true);
  const active = f.repo.forProgram(f.core.JOINT_PROGRAM).loadProgress(); assert.equal(active.id, 'legacy-joint-active');
  const repeated = await f.repo.importLegacy(f.repo.scanLegacy()); assert.equal(repeated.ok, true); assert.equal((await stateResponse(env)).records.length, 1);
  assert.equal(f.storage.getItem(`rehab-timer:v1:done:${completed.id}`), JSON.stringify(completed));
  assert.equal(f.storage.getItem(`rehab-timer:v1:date:${date}`), 'false');
  await start(f, 'after-legacy-new-session'); finish(f, 'after-legacy-new-session'); await f.repo.flush(); assert.equal(f.store.history().length, 1);
});

test('500条旧记录通过实际仓储上传无静默截断，501条禁止迁移并报告', async () => {
  const env = environment(), f = await connected(env);
  for (let n = 0; n < 500; n++) { const record = f.finish(`bulk-integration-${String(n).padStart(5, '0')}`).completion; f.storage.setItem(`rehab-timer:v1:done:${record.id}`, JSON.stringify(record)); }
  let preview = f.repo.scanLegacy(); assert.equal(preview.canImport, true); assert.equal(preview.counts.records, 500);
  const imported = await f.repo.importLegacy(preview); assert.equal(imported.ok, true, JSON.stringify(imported)); assert.equal((await stateResponse(env)).records.length, 500);
  const extra = f.finish('bulk-integration-extra').completion; f.storage.setItem(`rehab-timer:v1:done:${extra.id}`, JSON.stringify(extra));
  preview = f.repo.scanLegacy(); assert.equal(preview.canImport, false); assert.equal(preview.counts.records, 501); assert.equal(preview.counts.issues, 1);
  assert.equal((await f.repo.importLegacy(preview)).ok, false); assert.equal((await stateResponse(env)).records.length, 500);
});

test('同日撤销只作用指定记录，新的手工补记和真实完成通过真实API继续计数', async () => {
  const env = environment(), f = await connected(env), day = f.core.localDate(new Date(NOW));
  assert.equal(f.store.addManual(day), true); await f.repo.flush(); const previous = f.store.history()[0];
  assert.equal(f.store.revoke(previous.id), true); await f.repo.flush(); assert.equal(f.store.history().length, 0);
  await start(f); finish(f); await f.repo.flush();
  assert.equal(f.store.addManual(day), true); await f.repo.flush(); assert.equal(f.store.history().length, 2);
  const state = await stateResponse(env); assert.equal(state.records.length, 3); assert.equal(state.records.filter(r => r.revoked).length, 1);
});

test('正式域名测试参数仍不登录、不读写D1且不迁移正式旧键', async () => {
  const env = environment(), f = runtime(env, { search: '?test=1' });
  const record = f.finish('isolated-session-001').completion; f.storage.setItem(`rehab-timer:v1:done:${record.id}`, JSON.stringify(record));
  await f.repo.init(); assert.equal(f.repo.mode, 'local'); await start(f); finish(f); await f.repo.flush();
  assert.equal(f.network.calls.length, 0); assert.equal(f.repo.scanLegacy().disabled, true); assert.equal((await stateResponse(env)).records.length, 0);
});

test('完成响应丢失后被另一设备撤销，迟到原始ACK不能在本地复活撤销记录', async () => {
  const env = environment(), first = await connected(env); await start(first);
  first.network.drop = 'complete'; finish(first); await first.repo.flush();
  const second = await connected(env); assert.equal(second.store.history().length, 1);
  second.store.revoke(second.store.history()[0].id); await second.repo.flush();
  const reloaded = await connected(env, { storage: first.storage, network: first.network });
  assert.equal((await stateResponse(env)).records[0].revoked, true);
  assert.equal(reloaded.store.history().length, 0, 'A durable historical response must not undo a later known revocation.');
});

test('迁移响应丢失后会话已被接管，迟到迁移ACK不恢复过期写入权', async () => {
  const env = environment(), first = await connected(env);
  first.storage.setItem('rehab-timer:v1:progress', JSON.stringify(first.snapshot('legacy-claimed-session')));
  first.network.drop = 'import'; const outcome = await first.repo.importLegacy(first.repo.scanLegacy()); assert.equal(outcome.pending, true);
  const second = await connected(env); await second.repo.claimSession('legacy-claimed-session', first.core.PROGRAM);
  const reloaded = runtime(env, { storage: first.storage, network: first.network }); await reloaded.repo.init();
  assert.equal(reloaded.repo.status().state, 'conflict');
  assert.equal(reloaded.repo.sessions()[0].writerEpoch, 2);
  assert.equal(reloaded.store.loadProgress(), null, 'The old importer must not receive an expired writer token from a historical import acknowledgement.');
});

test('另存冲突完成时本地终态写失败，重试复用持久意图且只增加一次完成', async () => {
  const env = environment(), first = await connected(env); await start(first); first.network.offline = true;
  const second = await connected(env); await second.repo.claimSession('integration-session-001', first.core.PROGRAM);
  finish(first); await first.repo.flush(); first.network.offline = false; await first.repo.init();
  const conflict = first.repo.conflicts()[0], originalSet = first.storage.setItem.bind(first.storage); let failOnce = true;
  first.storage.setItem = (key, value) => {
    if (failOnce && key.includes(':terminal:') && !key.endsWith('integration-session-001')) { failOnce = false; throw new Error('synthetic-terminal-quota-failure'); }
    originalSet(key, value);
  };
  await assert.rejects(first.repo.resolveConflict(conflict.id, 'copy'), /synthetic-terminal-quota-failure/);
  await first.repo.flush(); assert.equal((await stateResponse(env)).records.length, 1); assert.equal(first.repo.conflicts().length, 1);
  await first.repo.resolveConflict(conflict.id, 'copy');
  assert.equal((await stateResponse(env)).records.length, 1, 'Retrying the same copy intent cannot add another completed training.');
  assert.equal(first.repo.conflicts().length, 0);
});

test('旧第5项中途快照规范化上传与接管，保留剩余时间和原始备份', async () => {
  const env=environment(),first=await connected(env);
  const old={...first.snapshot('legacy-round-two-001'),index:95,remaining:12500,state:'running'}; delete old.planRevision;
  first.storage.setItem('rehab-timer:v1:progress',JSON.stringify(old));
  const preview=first.repo.scanLegacy(),result=await first.repo.importLegacy(preview); assert.equal(result.ok,true);
  const sent=first.network.calls.find(call=>call.data?.type==='import').data.progress[0].snapshot;
  assert.equal(sent.planRevision,2); assert.equal(sent.index,96); assert.equal(sent.remaining,12500);
  const other=await connected(env),claimed=await other.repo.claimSession(old.id,first.core.PROGRAM);
  assert.equal(claimed.planRevision,2); assert.equal(claimed.index,96); assert.equal(claimed.state,'paused'); assert.equal(claimed.remaining,12500);
  const backup=JSON.parse(first.repo.backupLegacy()); assert.deepEqual(JSON.parse(backup.entries[0].value),old);
  assert.equal(first.storage.getItem('rehab-timer:v1:progress'),JSON.stringify(old));
});

test('旧index100终态和同ID历史导入只保留一次完成，日期不改且重试幂等', async () => {
  const env=environment(),f=await connected(env);
  const old={...f.finish('legacy-finished-final-001'),index:100}; delete old.planRevision;
  f.storage.setItem('rehab-timer:v1:progress',JSON.stringify(old));
  f.storage.setItem(`rehab-timer:v1:done:${old.id}`,JSON.stringify(old.completion));
  const preview=f.repo.scanLegacy(); assert.equal(preview.progress[0].snapshot.index,103); assert.equal(preview.progress[0].snapshot.planRevision,2);
  assert.deepEqual(plain(preview.progress[0].snapshot.completion),old.completion);
  const result=await f.repo.importLegacy(preview); assert.equal(result.ok,true); await f.repo.importLegacy(f.repo.scanLegacy());
  const state=await stateResponse(env); assert.equal(state.records.length,1); assert.equal(state.records[0].date,old.completion.date); assert.equal(state.records[0].finishedAt,old.completion.finishedAt);
  const session=state.sessions.find(item=>item.id===old.id); assert.equal(session.status,'completed'); assert.equal(session.snapshot.planRevision,2); assert.equal(session.snapshot.index,103);
  assert.equal(f.storage.getItem('rehab-timer:v1:progress'),JSON.stringify(old));
});

test('升级后原样重放已冻结的旧排程请求，不重写operationId或请求内容', async () => {
  const env=environment(),f=await connected(env),id='legacy-frozen-op-session';
  const snapshot={...f.snapshot(id),index:99,remaining:19000,state:'paused'}; delete snapshot.planRevision;
  const writerToken='legacy-frozen-writer-token-0000000000000000001';
  const request={operationId:'legacy-frozen-create-operation',type:'create',program:f.core.PROGRAM,sessionId:id,snapshot,writerToken};
  f.network.drop='create';
  await assert.rejects(f.network.fetch('/api/operation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}),/response lost/);
  f.storage.setItem(`${f.repo.prefix}:owner:${f.core.PROGRAM}:${id}`,JSON.stringify({revision:0,writerEpoch:1,writerToken}));
  f.storage.setItem(`${f.repo.prefix}:op:${request.operationId}`,JSON.stringify({id:request.operationId,type:'create',program:f.core.PROGRAM,sessionId:id,createdAt:NOW,sequence:1,owner:'legacy-tab-owner',payload:{program:f.core.PROGRAM,sessionId:id,snapshot,writerToken},request}));
  const reload=await connected(env,{storage:f.storage,network:f.network});
  const replay=f.network.calls.filter(call=>call.data?.operationId===request.operationId).at(-1).data;
  assert.deepEqual(replay,request); assert.equal(reload.repo.status().pending,0);
  const sessions=reload.repo.sessions(); assert.equal(sessions.length,1); assert.equal(sessions[0].snapshot.planRevision,2); assert.equal(sessions[0].snapshot.index,102);
});
