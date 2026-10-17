import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { SQLiteD1 } from './helpers/d1-sqlite.mjs';
import { onRequest } from '../functions/api/[[path]].js';
import { applyOperation, stateResponse } from '../functions/_lib/storage.js';
import { schedule } from '../functions/_lib/validation.js';
const P = 'five-stage-v1', J = 'lower-limb-joints-v1';
const TOKEN = 'synthetic-writer-token-00000000000000001';
const NOW = Date.parse('2026-10-17T03:00:00.000Z');
const DBS = [];
afterEach(() => { for (const db of DBS.splice(0)) db.close(); });
function setup() { const DB = new SQLiteD1(); DBS.push(DB); return { DB, APP_ENV: 'preview', SHARED_PASSPHRASE: 'synthetic-private-passphrase', SESSION_SECRET: 'synthetic-session-secret-000000000000000000000000000000' }; }
function snap(id = 'synthetic-session-001', program = P, patch = {}) { return { version: 1, program, unitMs: 1000, id, index: 0, remaining: 30000, state: 'paused', completion: null, ...patch }; }
function create(id = 'synthetic-session-001', program = P) { return { operationId: `create-${id}`, type: 'create', program, sessionId: id, snapshot: snap(id, program), writerToken: TOKEN }; }
function update(type, patch = {}) { return { operationId: `synthetic-${type}-operation`, type, program: P, sessionId: 'synthetic-session-001', expectedRevision: 1, writerEpoch: 1, writerToken: TOKEN, ...patch }; }
function complete(id = 'synthetic-session-001', program = P, patch = {}) {
  const completion = { version: 1, id, date: '2026-10-17', finishedAt: '2026-10-17T00:00:00.000Z' };
  return update('complete', { operationId: `complete-${id}`, program, sessionId: id, snapshot: snap(id, program, { index: schedule(program).length - 1, remaining: 0, state: 'finished', completion }), record: { ...completion, program, source: 'training', timeZone: 'Asia/Shanghai' }, ...patch });
}
async function call(env, path, method = 'GET', data, cookie, extra = {}) {
  const headers = { ...(method === 'GET' ? {} : { Origin: 'https://test.example', 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra };
  const response = await onRequest({ request: new Request(`https://test.example/api/${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }), env });
  return { response, body: await response.json() };
}
async function access(env) { const { response } = await call(env, 'login', 'POST', { passphrase: env.SHARED_PASSPHRASE }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; }
async function rejectCode(promise, code) { await assert.rejects(promise, error => error.code === code); }

test('服务端验证计划逐段对应实际训练核心，原计划101段、下肢99段', () => {
  const corePath = new URL('../src/core.js', import.meta.url);
  const source = existsSync(corePath) ? readFileSync(corePath, 'utf8') : [...readFileSync(new URL('../index.html', import.meta.url), 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  const context = vm.createContext({ Date }); vm.runInContext(source, context);
  for (const [program, plan] of [[P, context.RehabCore.plan], [J, context.RehabCore.jointPlan]]) {
    assert.deepEqual(schedule(program), JSON.parse(JSON.stringify(plan)).map(({ stage, kind, seconds }) => ({ stage, kind, seconds })));
  }
});
test('缺配置默认拒绝，所有读取和写入都需要认证，登录Cookie安全且不返回口令', async () => {
  const env = setup();
  assert.equal((await call({ ...env, SESSION_SECRET: '' }, 'state')).response.status, 503);
  assert.equal((await call({ ...env, SHARED_PASSPHRASE: '' }, 'state')).response.status, 503);
  assert.equal((await call(env, 'state')).response.status, 401);
  assert.equal((await call(env, 'operation', 'POST', create())).response.status, 401);
  assert.equal((await call(env, 'login', 'POST', { passphrase: 'invalid' })).response.status, 401);
  const login = await call(env, 'login', 'POST', { passphrase: env.SHARED_PASSPHRASE });
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.match(login.response.headers.get('set-cookie'), /Path=\/api/);
  assert.deepEqual(login.body, { ok: true, environment: 'preview' });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(env, 'state', 'GET', undefined, cookie)).response.status, 200);
  assert.equal((await call(env, 'state', 'GET', undefined, `${cookie}bad`)).response.status, 401);
  assert.equal((await call({ ...env, SHARED_PASSPHRASE: 'changed-passphrase' }, 'state', 'GET', undefined, cookie)).response.status, 401);
  const out = await call(env, 'logout', 'POST', {}, cookie); assert.match(out.response.headers.get('set-cookie'), /Max-Age=0/);
});
test('来源、内容类型、请求尺寸和错误JSON受到检查，不暴露数据库错误', async t => {
  const env = setup(), cookie = await access(env);
  assert.equal((await call(env, 'operation', 'POST', create(), cookie, { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await call(env, 'state', 'GET', undefined, cookie, { 'Sec-Fetch-Site': 'cross-site' })).response.status, 403);
  assert.equal((await call(env, 'operation', 'POST', create(), cookie, { 'Content-Type': 'text/plain' })).response.status, 415);
  assert.equal((await call(env, 'operation', 'POST', { value: 'x'.repeat(1024 * 1024) }, cookie)).response.status, 413);
  const malformed = await onRequest({ request: new Request('https://test.example/api/operation', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://test.example', 'Content-Type': 'application/json' }, body: '{bad' }), env });
  assert.equal(malformed.status, 400);
  const missingOrigin = await onRequest({ request: new Request('https://test.example/api/operation', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }), env }); assert.equal(missingOrigin.status, 403);
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  env.DB.failStatement = () => true;
  const unavailable = await call(env, 'state', 'GET', undefined, cookie); assert.equal(unavailable.response.status, 503); assert.equal(JSON.stringify(unavailable.body).includes('injected'), false);
  assert.deepEqual(logs, [['rehab-api-failure', 'Error']]);
});
test('登录失败限速原子计数，不把客户端伪造XFF当身份', async () => {
  const env = setup();
  for (let n = 0; n < 10; n++) assert.equal((await call(env, 'login', 'POST', { passphrase: 'wrong' }, undefined, { 'X-Forwarded-For': `pretend-${n}` })).response.status, 401);
  const result = await call(env, 'login', 'POST', { passphrase: env.SHARED_PASSPHRASE });
  assert.equal(result.response.status, 429); assert.equal(result.response.headers.get('retry-after'), '900');
});
test('两人独立训练和两套计划同ID互不覆盖，状态响应不含写入令牌hash', async () => {
  const env = setup();
  await applyOperation(env, create(), NOW);
  await applyOperation(env, create('synthetic-session-002'), NOW);
  await applyOperation(env, { ...create('synthetic-session-001', J), operationId: 'create-joint-session' }, NOW);
  const state = await stateResponse(env); assert.equal(state.sessions.length, 3); assert.equal(state.records.length, 0);
  assert.equal(JSON.stringify(state).includes(TOKEN), false); assert.equal(JSON.stringify(state).includes('writerHash'), false);
  assert.deepEqual(state.sessions.map(s => s.revision), [1, 1, 1]);
});
test('持久操作日志保证响应丢失后重试返回原结果，键顺序无关，ID复用不同内容拒绝', async () => {
  const env = setup(), input = create();
  const first = await applyOperation(env, input, NOW);
  const repeat = await applyOperation(env, Object.fromEntries(Object.entries(input).reverse()), NOW + 10000);
  assert.deepEqual(first, repeat);
  await rejectCode(applyOperation(env, { ...input, writerToken: `${TOKEN}other` }, NOW), 'operation_id_reused');
  assert.equal((await stateResponse(env)).sessions.length, 1);
});
test('完成与记录在一个事务中保存，重试不重复，迟到进度和结束不能复活终态', async () => {
  const env = setup(); await applyOperation(env, create(), NOW);
  const input = complete(), first = await applyOperation(env, input, NOW);
  assert.equal(first.session.status, 'completed'); assert.equal(first.session.revision, 2);
  assert.deepEqual(await applyOperation(env, input, NOW + 9999), first);
  const state = await stateResponse(env); assert.equal(state.records.length, 1); assert.equal(state.records[0].date, '2026-10-17');
  await rejectCode(applyOperation(env, update('progress', { snapshot: snap() }), NOW), 'session_terminal');
  await rejectCode(applyOperation(env, update('abandon', { expectedRevision: 2 }), NOW), 'session_terminal');
});
test('结束不打卡，迟到完成也不能恢复已结束训练', async () => {
  const env = setup(); await applyOperation(env, create(), NOW); await applyOperation(env, update('abandon'), NOW);
  await rejectCode(applyOperation(env, complete(), NOW), 'session_terminal');
  const state = await stateResponse(env); assert.equal(state.records.length, 0); assert.equal(state.sessions[0].status, 'abandoned');
});
test('过期版本不会被当作成功，手动接管递增epoch并拒绝旧终端', async () => {
  const env = setup(); await applyOperation(env, create(), NOW);
  const progress = update('progress', { snapshot: snap(undefined, P, { remaining: 28000 }) }); await applyOperation(env, progress, NOW);
  await rejectCode(applyOperation(env, { ...progress, operationId: 'stale-progress-operation' }, NOW), 'revision_conflict');
  const claim = { operationId: 'claim-synthetic-operation', type: 'claim', program: P, sessionId: 'synthetic-session-001', expectedRevision: 2 };
  const got = await applyOperation(env, claim, NOW); assert.equal(got.session.revision, 3); assert.equal(got.session.writerEpoch, 2); assert.equal(got.writerToken.length, 64); assert.equal(got.session.snapshot.state, 'paused');
  assert.deepEqual(await applyOperation(env, claim, NOW), got);
  const rawLog = await env.DB.prepare('SELECT response FROM operation_log WHERE operation_id = ?').bind(claim.operationId).first(); assert.equal(rawLog.response.includes(got.writerToken), false);
  await rejectCode(applyOperation(env, update('progress', { operationId: 'old-writer-progress', expectedRevision: 3, snapshot: snap() }), NOW), 'writer_conflict');
  const saved = await applyOperation(env, update('progress', { operationId: 'new-writer-progress', expectedRevision: 3, writerEpoch: 2, writerToken: got.writerToken, snapshot: snap() }), NOW); assert.equal(saved.session.revision, 4);
});
test('并发写入触发实际SQLite CHECK回滚，再按原版本报告冲突', async () => {
  const env = setup(); await applyOperation(env, create(), NOW);
  env.DB.beforeWrite = () => applyOperation(env, update('progress', { operationId: 'concurrent-progress-01', snapshot: snap(undefined, P, { remaining: 20000 }) }), NOW);
  await rejectCode(applyOperation(env, complete(), NOW), 'revision_conflict');
  const state = await stateResponse(env); assert.equal(state.records.length, 0); assert.equal(state.sessions[0].revision, 2); assert.equal(state.sessions[0].snapshot.remaining, 20000);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM write_guards').first()).n, 0);
});
test('同操作并发重试返回第一次响应，独立会话并发自动重试且不丢数据', async () => {
  const env = setup(), input = create(); env.DB.beforeWrite = () => applyOperation(env, input, NOW);
  const got = await applyOperation(env, input, NOW); assert.equal(got.session.revision, 1);
  env.DB.beforeWrite = () => applyOperation(env, create('concurrent-session-003'), NOW);
  await applyOperation(env, create('concurrent-session-002'), NOW); assert.equal((await stateResponse(env)).sessions.length, 3);
});
test('中途数据库错误回滚已插入的完成记录，会话和操作日志均保持原值', async () => {
  const env = setup(); await applyOperation(env, create(), NOW);
  env.DB.failStatement = sql => sql.startsWith('UPDATE sessions');
  await assert.rejects(applyOperation(env, complete(), NOW), /injected-storage-error/);
  env.DB.failStatement = null;
  const state = await stateResponse(env); assert.equal(state.records.length, 0); assert.equal(state.sessions[0].status, 'active'); assert.equal(state.sessions[0].revision, 1);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM operation_log').first()).n, 1);
});
test('补记和明确ID撤销保留原始记录，同日后来完成仍计数', async () => {
  const env = setup();
  const manual = { operationId: 'manual-synthetic-operation', type: 'manual', program: P, record: { id: 'manual-record-001', program: P, date: '2026-10-17', source: 'manual', finishedAt: null } };
  await applyOperation(env, manual, NOW); await applyOperation(env, { operationId: 'revoke-manual-operation', type: 'revoke', program: P, recordId: manual.record.id }, NOW);
  await applyOperation(env, create(), NOW); await applyOperation(env, complete(), NOW);
  const state = await stateResponse(env); assert.equal(state.records.length, 2); assert.equal(state.records.filter(r => !r.revoked).length, 1);
  assert.equal(state.records.find(r => r.id === manual.record.id).finishedAt, null);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM records').first()).n, 2);
});
test('正式API拒绝测试unitMs、非法计划、非法快照和不一致完成日期', async () => {
  const env = setup();
  for (const patch of [{ unitMs: 100 }, { index: 999 }, { remaining: 30001 }, { state: 'manual' }, { state: 'ready' }]) await rejectCode(applyOperation(env, { ...create(), snapshot: snap(undefined, P, patch) }, NOW), 'invalid_input');
  await rejectCode(applyOperation(env, { ...create(), program: 'test-program' }, NOW), 'invalid_input');
  await applyOperation(env, create(), NOW);
  const input = complete(); input.record.date = '2026-10-16'; await rejectCode(applyOperation(env, input, NOW), 'invalid_input');
  assert.equal((await stateResponse(env)).records.length, 0);
});
test('跨午夜的次日补传保留完成本地日期，时区冲突拒绝', async () => {
  const env = setup(); await applyOperation(env, create(), NOW);
  const input = complete(); input.record.date = '2026-10-16'; input.record.finishedAt = '2026-10-16T15:59:00.000Z'; input.snapshot.completion = { version: 1, id: input.sessionId, date: input.record.date, finishedAt: input.record.finishedAt };
  await applyOperation(env, input, NOW); assert.equal((await stateResponse(env)).records[0].date, '2026-10-16');
});
test('下肢第二组手工就位可恢复，最后手工完成保存', async () => {
  const env = setup(), input = create('joint-session-001', J);
  input.snapshot = snap(input.sessionId, J, { index: schedule(J).length - 1, remaining: 0, state: 'ready' });
  await applyOperation(env, input, NOW); const done = await applyOperation(env, complete(input.sessionId, J), NOW); assert.equal(done.session.status, 'completed');
});
const legacyRecord = (id = 'legacy-session-001', program = P) => ({ key: `${program === P ? 'rehab-timer:v1' : 'rehab-timer:v1:joint'}:done:${id}`, program, record: { version: 1, id, date: '2026-10-16', finishedAt: '2026-10-16T10:00:00.000Z' } });
function importing(patch = {}) { return { operationId: 'import-synthetic-operation', type: 'import', sourceId: 'source-synthetic-browser', records: [], overrides: [], progress: [], ...patch }; }
const override = (completed, program = P) => ({ key: `${program === P ? 'rehab-timer:v1' : 'rehab-timer:v1:joint'}:date:2026-10-16`, program, date: '2026-10-16', completed });
test('迁移保留原始会话、按ID去重、false只撤销本批新插入，重复导入不增次数', async () => {
  const env = setup(), input = importing({ records: [legacyRecord(), legacyRecord('legacy-session-002')], overrides: [override(false)] });
  const first = await applyOperation(env, input, NOW); assert.equal(first.import.insertedRecords.length, 2); assert.equal(first.import.revokedRecordIds.length, 2);
  assert.deepEqual(await applyOperation(env, input, NOW), first);
  const repeat = await applyOperation(env, { ...input, operationId: 'import-repeat-operation' }, NOW); assert.equal(repeat.import.insertedRecords.length, 0); assert.equal(repeat.import.revokedRecordIds.length, 0); assert.equal(repeat.import.conflicts.length, 0);
  const state = await stateResponse(env); assert.equal(state.records.length, 2); assert.equal(state.records.filter(r => !r.revoked).length, 0);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM legacy_imports').first()).n, 2);
});
test('另一设备迁移false不能撤销云端已有记录，返回明确冲突', async () => {
  const env = setup(); await applyOperation(env, importing({ records: [legacyRecord()] }), NOW);
  const input = importing({ operationId: 'import-second-device', sourceId: 'source-second-browser', records: [legacyRecord(), legacyRecord('new-legacy-session')], overrides: [override(false)] });
  const got = await applyOperation(env, input, NOW); assert.equal(got.import.conflicts[0].reason, 'existing_record_not_revoked'); assert.equal(got.import.revokedRecordIds.length, 1);
  const state = await stateResponse(env); assert.equal(state.records.find(r => r.id === 'legacy-session-001').revoked, false);
});
test('旧true只在无有效记录时补记，稳定ID不随导入时间改变且后续撤销不复活', async () => {
  const env = setup(), input = importing({ overrides: [override(true)] });
  const got = await applyOperation(env, input, NOW); assert.equal(got.import.manualRecordIds.length, 1);
  const recordId = got.import.manualRecordIds[0].id;
  await applyOperation(env, { operationId: 'revoke-import-manual', type: 'revoke', program: P, recordId }, NOW);
  await applyOperation(env, { ...input, operationId: 'import-true-repeat' }, NOW + 10000);
  assert.equal((await stateResponse(env)).records.length, 1); assert.equal((await stateResponse(env)).records[0].revoked, true);
  const env2 = setup(); await applyOperation(env2, importing({ records: [legacyRecord()], overrides: [override(true)] }), NOW); assert.equal((await stateResponse(env2)).records.length, 1);
});
test('迁移读取正式原键，测试前缀和损坏内容整批拒绝，不部分保存', async () => {
  const env = setup(), valid = legacyRecord(), invalid = { ...legacyRecord('legacy-session-002'), key: 'rehab-timer:test:v1:100:done:legacy-session-002' };
  await rejectCode(applyOperation(env, importing({ records: [valid, invalid] }), NOW), 'invalid_input'); assert.equal((await stateResponse(env)).records.length, 0);
  await rejectCode(applyOperation(env, importing({ overrides: [{ ...override(false), completed: 'false' }] }), NOW), 'invalid_input');
  await rejectCode(applyOperation(env, importing({ records: [{ ...valid, record: { ...valid.record, version: 2 } }] }), NOW), 'invalid_input');
});
test('迁移未完进度暂停保留，终态进度修复缺失历史且不保存明文写入令牌', async () => {
  const env = setup();
  const terminal = complete('legacy-terminal-001', J).snapshot;
  const input = importing({ progress: [
    { key: 'rehab-timer:v1:progress', program: P, snapshot: snap('legacy-active-001', P, { state: 'running', remaining: 29000 }), writerToken: TOKEN },
    { key: 'rehab-timer:v1:joint:progress', program: J, snapshot: terminal, writerToken: TOKEN }
  ] });
  const got = await applyOperation(env, input, NOW); assert.equal(got.import.insertedSessions.length, 2); assert.equal(got.import.insertedRecords.length, 1);
  const state = await stateResponse(env); assert.equal(state.sessions.find(s => s.program === P).snapshot.state, 'paused'); assert.equal(state.sessions.find(s => s.program === J).status, 'completed');
  const raw = await env.DB.prepare('SELECT raw_payload FROM legacy_imports').first(); assert.equal(raw.raw_payload.includes(TOKEN), false);
});
test('最大迁移500条记录及500覆盖用JSON1批量绑定，总查询数低于50且回滚完整', async () => {
  const env = setup(), records = [], overrides = [];
  for (let i = 0; i < 500; i++) {
    const day = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const entry = legacyRecord(`legacy-bulk-${String(i).padStart(6, '0')}`); entry.record.date = day; entry.record.finishedAt = `${day}T10:00:00.000Z`; records.push(entry);
    overrides.push({ key: `rehab-timer:v1:date:${day}`, program: P, date: day, completed: false });
  }
  const before = env.DB.queries;
  const response = await applyOperation(env, importing({ records, overrides }), NOW);
  assert.equal(response.import.insertedRecords.length, 500); assert.equal(response.import.revokedRecordIds.length, 500);
  assert.ok(env.DB.queries - before < 50, `actual D1 queries: ${env.DB.queries - before}`);
  assert.equal((await stateResponse(env)).records.filter(r => !r.revoked).length, 0);
  const env2 = setup(); env2.DB.failStatement = sql => sql.startsWith('INSERT INTO legacy_imports');
  await assert.rejects(applyOperation(env2, importing({ records, overrides }), NOW), /injected-storage-error/);
  env2.DB.failStatement = null; assert.equal((await stateResponse(env2)).records.length, 0);
});
