import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteD1 } from './helpers/d1-sqlite.mjs';
import { onRequest } from '../functions/api/[[path]].js';

const A = 'five-stage-v1', B = 'lower-limb-joints-v1';
const DBS = [];
afterEach(() => { for (const db of DBS.splice(0)) db.close(); });
function setup() { const DB = new SQLiteD1(); DBS.push(DB); return { DB, APP_ENV: 'preview' }; }
async function call(env, path, method = 'GET', data, headers = {}) {
  const init = { method, headers: { ...(method === 'GET' ? {} : { Origin: 'https://test.example', 'Content-Type': 'application/json' }), ...headers } };
  if (data !== undefined) init.body = typeof data === 'string' ? data : JSON.stringify(data);
  const response = await onRequest({ request: new Request(`https://test.example/api/${path}`, init), env });
  return { status: response.status, body: await response.json() };
}
const training = (id = 'synthetic-session-0001', patch = {}) => ({ version: 1, id, program: A, date: '2026-10-30', finishedAt: '2026-10-30T02:00:00.000Z', source: 'training', timeZone: 'Asia/Shanghai', ...patch });

test('不需要口令或会话密钥；缺少数据库或环境标识时返回 503', async () => {
  assert.equal((await call({ APP_ENV: 'preview' }, 'records')).status, 503);
  assert.equal((await call({ DB: setup().DB }, 'records')).status, 503);
  const env = setup();
  const { status, body } = await call(env, 'records');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, environment: 'preview', records: [] });
});

test('完成记录按标识幂等保存；同标识不同内容返回冲突且原记录不变', async () => {
  const env = setup();
  const first = await call(env, 'records', 'POST', { record: training() });
  assert.equal(first.status, 200);
  assert.equal(first.body.record.source, 'training');
  assert.equal((await call(env, 'records', 'POST', { record: training() })).status, 200, '重试返回已保存的记录');
  const conflict = await call(env, 'records', 'POST', { record: training(undefined, { date: '2026-10-29', finishedAt: '2026-10-29T02:00:00.000Z' }) });
  assert.equal(conflict.status, 409);
  const { body } = await call(env, 'records');
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].date, '2026-10-30');
});

test('补记没有完成时间；旧版导入的记录与训练记录视为同一种', async () => {
  const env = setup();
  const manual = await call(env, 'records', 'POST', { record: { version: 1, id: 'manual-synthetic-0001', program: B, date: '2026-10-29', finishedAt: null, source: 'manual', timeZone: null } });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.record.finishedAt, null);
  const faked = await call(env, 'records', 'POST', { record: { version: 1, id: 'manual-synthetic-0002', program: B, date: '2026-10-29', finishedAt: '2026-10-29T02:00:00.000Z', source: 'manual', timeZone: null } });
  assert.equal(faked.status, 400);
  assert.equal((await call(env, 'records', 'POST', { record: training('synthetic-legacy-0001', { source: 'legacy', timeZone: null }) })).status, 200);
  assert.equal((await call(env, 'records', 'POST', { record: training('synthetic-legacy-0001', { source: 'training', timeZone: null }) })).status, 200);
  const adjustments = env.DB.database.prepare("SELECT kind FROM calendar_adjustments").all().map(r => r.kind);
  assert.deepEqual(adjustments, ['manual']);
});

test('撤销只作用于那一条，重复撤销不重复写；不存在的记录返回 404', async () => {
  const env = setup();
  await call(env, 'records', 'POST', { record: training('synthetic-session-0010') });
  await call(env, 'records', 'POST', { record: training('synthetic-session-0011') });
  const revoked = await call(env, 'records/revoke', 'POST', { program: A, id: 'synthetic-session-0010' });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.record.revoked, true);
  assert.equal((await call(env, 'records/revoke', 'POST', { program: A, id: 'synthetic-session-0010' })).status, 200);
  assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS n FROM calendar_adjustments WHERE kind = 'revoke'").get().n, 1);
  assert.equal((await call(env, 'records/revoke', 'POST', { program: A, id: 'synthetic-missing-01' })).status, 404);
  const { body } = await call(env, 'records');
  assert.deepEqual(body.records.map(r => [r.id, r.revoked]).sort(), [['synthetic-session-0010', true], ['synthetic-session-0011', false]]);
  // A later completion on the same day still counts.
  await call(env, 'records', 'POST', { record: training('synthetic-session-0012') });
  assert.equal((await call(env, 'records')).body.records.filter(r => !r.revoked && r.date === '2026-10-30').length, 2);
});

test('上一版本写入的记录和撤销照常读出', async () => {
  const env = setup();
  const db = env.DB.database;
  db.prepare("INSERT INTO records (program, id, date, finished_at, source, time_zone, created_at, import_id) VALUES (?, ?, ?, ?, 'training', NULL, ?, NULL)").run(A, 'synthetic-old-0001', '2026-10-01', '2026-10-01T01:00:00.000Z', '2026-10-01T01:00:00.000Z');
  db.prepare("INSERT INTO records (program, id, date, finished_at, source, time_zone, created_at, import_id) VALUES (?, ?, ?, NULL, 'manual', NULL, ?, NULL)").run(B, 'synthetic-old-0002', '2026-10-02', '2026-10-02T01:00:00.000Z');
  db.prepare("INSERT INTO calendar_adjustments (operation_id, kind, program, record_id, created_at) VALUES ('synthetic-op-0001', 'revoke', ?, ?, '2026-10-03T00:00:00.000Z')").run(B, 'synthetic-old-0002');
  const { body } = await call(env, 'records');
  const byId = Object.fromEntries(body.records.map(r => [r.id, r]));
  assert.equal(byId['synthetic-old-0001'].revoked, false);
  assert.equal(byId['synthetic-old-0002'].revoked, true);
  assert.equal(byId['synthetic-old-0002'].revokedAt, '2026-10-03T00:00:00.000Z');
});

test('输入校验：未来日期、未知计划、日期与时区不一致、多余字段都会拒绝', async () => {
  const env = setup();
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  for (const record of [
    training('synthetic-bad-0001', { date: future, finishedAt: `${future}T02:00:00.000Z` }),
    training('synthetic-bad-0002', { program: 'unknown-plan' }),
    training('synthetic-bad-0003', { date: '2026-10-29' }),
    { ...training('synthetic-bad-0004'), extra: true },
    training('bad id!', {})
  ]) assert.equal((await call(env, 'records', 'POST', { record })).status, 400, JSON.stringify(record));
  assert.equal((await call(env, 'records', 'POST', { record: training(), more: 1 })).status, 400);
});

test('同源与格式：跨站写入 403，非 JSON 415，旧接口提示刷新，未知路径 404', async () => {
  const env = setup();
  assert.equal((await call(env, 'records', 'POST', { record: training() }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, 'records', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call(env, 'records', 'POST', 'x', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call(env, 'records', 'POST', '{bad')).status, 400);
  assert.equal((await call(env, 'state')).status, 410);
  assert.equal((await call(env, 'operation', 'POST', {})).status, 410);
  assert.equal((await call(env, 'nothing')).status, 404);
});

test('数据库异常返回 503，不泄露细节', async () => {
  const env = setup();
  env.DB.failStatement = sql => sql.startsWith('INSERT');
  const { status, body } = await call(env, 'records', 'POST', { record: training() });
  assert.equal(status, 503);
  assert.equal(body.error.code, 'storage_unavailable');
});
