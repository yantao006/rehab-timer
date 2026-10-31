import { fail, fields, id, program, record } from './validation.js';
// Records live in the existing `records` table; revocations stay additive in `calendar_adjustments`.
// Older tables (sessions, operation_log, legacy_imports, ...) are kept read-only and untouched.
const SELECT = `SELECT r.program, r.id, r.date, r.finished_at, r.source, r.time_zone,
  (SELECT MIN(a.created_at) FROM calendar_adjustments a WHERE a.program = r.program AND a.record_id = r.id AND a.kind = 'revoke') AS revoked_at
  FROM records r`;
const shape = row => ({ id: row.id, program: row.program, date: row.date, finishedAt: row.finished_at, source: row.source, timeZone: row.time_zone, revoked: row.revoked_at !== null, revokedAt: row.revoked_at });
async function find(db, programId, recordId) {
  const row = await db.prepare(`${SELECT} WHERE r.program = ? AND r.id = ?`).bind(programId, recordId).first();
  return row ? shape(row) : null;
}
export async function listRecords(env) {
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY r.date DESC, r.id`).all();
  return { ok: true, environment: env.APP_ENV, records: results.map(shape) };
}
// Imported (legacy) and app-recorded (training) completions are the same kind of record.
const kind = source => source === 'manual' ? 'manual' : 'timed';
const same = (a, b) => a.date === b.date && a.finishedAt === b.finishedAt && kind(a.source) === kind(b.source);
// Idempotent by (program, id): retries return the stored record; different content is a conflict.
export async function putRecord(env, body, now = Date.now()) {
  fields(body, ['record'], '请求');
  const value = record(body.record, now);
  const stamp = new Date(now).toISOString();
  const statements = [env.DB.prepare('INSERT OR IGNORE INTO records (program, id, date, finished_at, source, time_zone, created_at, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
    .bind(value.program, value.id, value.date, value.finishedAt, value.source, value.timeZone, stamp)];
  if (value.source === 'manual') statements.push(env.DB.prepare("INSERT OR IGNORE INTO calendar_adjustments (operation_id, kind, program, record_id, created_at) VALUES (?, 'manual', ?, ?, ?)")
    .bind(`manual-${value.program}-${value.id}`, value.program, value.id, stamp));
  await env.DB.batch(statements);
  const stored = await find(env.DB, value.program, value.id);
  if (!stored) fail(503, 'storage_unavailable', '记录暂时无法保存。');
  if (!same(stored, value)) fail(409, 'record_conflict', '同一标识已有不同内容的记录，原记录未改动。');
  return { ok: true, record: stored };
}
export async function revokeRecord(env, body, now = Date.now()) {
  fields(body, ['program', 'id'], '请求');
  program(body.program); id(body.id, '记录标识');
  const existing = await find(env.DB, body.program, body.id);
  if (!existing) fail(404, 'record_missing', '需要撤销的记录不存在。');
  if (!existing.revoked) {
    await env.DB.prepare("INSERT OR IGNORE INTO calendar_adjustments (operation_id, kind, program, record_id, created_at) VALUES (?, 'revoke', ?, ?, ?)")
      .bind(`revoke-${body.program}-${body.id}`, body.program, body.id, new Date(now).toISOString()).run();
  }
  return { ok: true, record: await find(env.DB, body.program, body.id) };
}
