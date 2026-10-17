import { canonical, claimToken, digest, equal } from './crypto.js';
import { assertInput, date, fail, id, legacyKey, list, object, operation, program, record, revision, snapshot, token } from './validation.js';
const keyFor = (program, id) => `${program}:${id}`;
// JSON1 packs a whole migration table into one bound parameter and one D1 query.
// Group insertion by table while retaining first-use order (records precede their adjustments).
function queueInsert(statements, table, columns, row) {
  let group = statements.find(statement => statement.insertTable === table);
  if (!group) { group = { insertTable: table, columns, rows: [] }; statements.push(group); }
  group.rows.push(row);
}
function compileStatements(db, statements) {
  return statements.map(statement => {
    if (!statement.insertTable) return statement;
    const select = statement.columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ');
    return db.prepare(`INSERT INTO ${statement.insertTable} (${statement.columns.join(', ')}) SELECT ${select} FROM json_each(?)`).bind(JSON.stringify(statement.rows));
  });
}
const sameRecord = (a, b) => a.date === b.date && a.finishedAt === b.finishedAt;
const sqlSession = row => ({ id: row.id, program: row.program, status: row.status, snapshot: JSON.parse(row.snapshot), revision: row.revision, writerEpoch: row.writer_epoch, updatedAt: row.updated_at });
export async function readState(db) {
  const [version, sessions, records, adjustments] = await db.batch([
    db.prepare('SELECT revision FROM app_state WHERE id = 1'),
    db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, program, id'),
    db.prepare(`SELECT r.*, (SELECT MIN(a.created_at) FROM calendar_adjustments a WHERE a.program = r.program AND a.record_id = r.id AND a.kind = 'revoke') AS revoked_at FROM records r ORDER BY r.date DESC, r.id`),
    db.prepare('SELECT adjustment_id FROM legacy_adjustments')
  ]);
  return {
    revision: version.results[0].revision,
    sessions: new Map(sessions.results.map(row => [keyFor(row.program, row.id), { ...sqlSession(row), writerHash: row.writer_hash }])),
    records: new Map(records.results.map(row => [keyFor(row.program, row.id), { id: row.id, program: row.program, date: row.date, finishedAt: row.finished_at, source: row.source, timeZone: row.time_zone, revoked: row.revoked_at !== null, revokedAt: row.revoked_at }])),
    adjustments: new Set(adjustments.results.map(row => row.adjustment_id))
  };
}
const publicSession = session => {
  if (!session) return undefined;
  const { writerHash, ...value } = session;
  return value;
};
export async function stateResponse(env) {
  const state = await readState(env.DB);
  return { ok: true, environment: env.APP_ENV, records: [...state.records.values()], sessions: [...state.sessions.values()].map(publicSession) };
}
function sessionConflict(session, code = 'revision_conflict', message = '此训练已在另一处更新，请核对后继续。') {
  fail(409, code, message, { session: publicSession(session) });
}
function assertActive(session) {
  if (!session) fail(409, 'session_missing', '训练会话尚未创建。');
  if (session.status !== 'active') sessionConflict(session, 'session_terminal', '此训练已经完成或结束，不能再修改进度。');
}
async function assertWriter(session, input) {
  revision(input.expectedRevision); revision(input.writerEpoch); token(input.writerToken);
  assertActive(session);
  if (input.writerEpoch !== session.writerEpoch || !equal(await digest(input.writerToken), session.writerHash)) sessionConflict(session, 'writer_conflict', '此训练已由另一设备接管，请保留本地进度并核对。');
  if (input.expectedRevision !== session.revision) sessionConflict(session);
}
function putSession(db, statements, state, session, creating = false) {
  const args = [session.status, JSON.stringify(session.snapshot), session.revision, session.writerEpoch, session.writerHash, session.updatedAt, session.program, session.id];
  statements.push(creating
    ? db.prepare('INSERT INTO sessions (status, snapshot, revision, writer_epoch, writer_hash, updated_at, program, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(...args)
    : db.prepare('UPDATE sessions SET status = ?, snapshot = ?, revision = ?, writer_epoch = ?, writer_hash = ?, updated_at = ? WHERE program = ? AND id = ?').bind(...args));
  state.sessions.set(keyFor(session.program, session.id), session);
}
function putRecord(db, statements, state, value, now, importId = null) {
  queueInsert(statements, 'records', ['program', 'id', 'date', 'finished_at', 'source', 'time_zone', 'created_at', 'import_id'], [value.program, value.id, value.date, value.finishedAt, value.source, value.timeZone, now, importId]);
  state.records.set(keyFor(value.program, value.id), value);
}
function adjustment(db, statements, kind, operationId, value, now) {
  queueInsert(statements, 'calendar_adjustments', ['operation_id', 'kind', 'program', 'record_id', 'created_at'], [operationId, kind, value.program, value.id, now]);
  if (kind === 'revoke') { value.revoked = true; value.revokedAt = value.revokedAt || now; }
}
function assertUnique(value, map) {
  if (map.has(keyFor(value.program, value.id))) fail(409, 'record_exists', '同标识记录已存在，原记录未改动。');
}
async function prepareImport(env, input, state, statements, now, currentTime) {
  id(input.sourceId, '导入来源');
  list(input.records, 500, '旧完成记录'); list(input.overrides, 500, '旧日期修改'); list(input.progress, 2, '旧训练进度');
  const result = { sourceId: input.sourceId, insertedRecords: [], insertedSessions: [], revokedRecordIds: [], manualRecordIds: [], conflicts: [] };
  const added = new Set(), originalRecords = new Map(state.records), seenRecords = new Map(), seenProgress = new Set(), seenOverrides = new Set();
  const ref = value => ({ program: value.program, id: value.id });
  const recordsToImport = [];
  for (const entry of input.records) {
    assertInput(object(entry), '旧完成记录格式不正确。'); program(entry.program);
    const value = record(entry.record, entry.program, 'legacy', currentTime, true);
    legacyKey(entry.key, entry.program, `done:${value.id}`);
    const k = keyFor(value.program, value.id);
    if (seenRecords.has(k)) assertInput(sameRecord(seenRecords.get(k), value), '同一旧记录有相互冲突的内容。');
    else { seenRecords.set(k, value); recordsToImport.push(value); }
  }
  const progressToImport = [];
  for (const entry of input.progress) {
    assertInput(object(entry), '旧进度格式不正确。'); program(entry.program); token(entry.writerToken);
    legacyKey(entry.key, entry.program, 'progress');
    id(entry.snapshot?.id, '旧进度标识');
    assertInput(!seenProgress.has(entry.program), '每套计划最多导入一条未结束进度。'); seenProgress.add(entry.program);
    const value = snapshot(entry.snapshot, entry.program, entry.snapshot.id, currentTime);
    progressToImport.push({ ...entry, snapshot: value });
    if (value.state === 'finished') {
      const completed = record(value.completion, entry.program, 'legacy', currentTime, true), k = keyFor(completed.program, completed.id);
      if (seenRecords.has(k)) assertInput(sameRecord(seenRecords.get(k), completed), '旧终态与旧完成记录冲突。');
      else { seenRecords.set(k, completed); recordsToImport.push(completed); }
    }
  }
  for (const value of recordsToImport) {
    const k = keyFor(value.program, value.id), existing = state.records.get(k), existingSession = state.sessions.get(k);
    if (existing) {
      if (!sameRecord(existing, value)) result.conflicts.push({ ...ref(value), reason: 'record_content_mismatch' });
      continue;
    }
    if (existingSession) { result.conflicts.push({ ...ref(value), reason: 'existing_session_preserved' }); continue; }
    putRecord(env.DB, statements, state, value, now, input.operationId);
    added.add(k); result.insertedRecords.push(ref(value));
  }
  for (const entry of progressToImport) {
    const k = keyFor(entry.program, entry.snapshot.id), existingSession = state.sessions.get(k), existingRecord = state.records.get(k);
    if (existingSession || (entry.snapshot.state !== 'finished' && existingRecord)) {
      result.conflicts.push({ program: entry.program, id: entry.snapshot.id, reason: 'existing_session_preserved' }); continue;
    }
    if (entry.snapshot.state === 'finished' && (!existingRecord || !sameRecord(existingRecord, entry.snapshot.completion))) {
      result.conflicts.push({ program: entry.program, id: entry.snapshot.id, reason: 'record_content_mismatch' }); continue;
    }
    const recovered = { ...entry.snapshot, state: entry.snapshot.state === 'finished' || entry.snapshot.state === 'ready' ? entry.snapshot.state : 'paused' };
    const session = { id: entry.snapshot.id, program: entry.program, status: recovered.state === 'finished' ? 'completed' : 'active', snapshot: recovered, revision: 1, writerEpoch: 1, writerHash: await digest(entry.writerToken), updatedAt: now };
    putSession(env.DB, statements, state, session, true); result.insertedSessions.push(ref(session));
  }
  for (const entry of input.overrides) {
    assertInput(object(entry), '旧日期修改格式不正确。'); program(entry.program); date(entry.date, currentTime);
    assertInput(typeof entry.completed === 'boolean', '旧日期修改必须为布尔值。');
    legacyKey(entry.key, entry.program, `date:${entry.date}`);
    const overrideKey = `${entry.program}:${entry.key}`;
    assertInput(!seenOverrides.has(overrideKey), '同一旧日期修改只能出现一次。'); seenOverrides.add(overrideKey);
    const stableId = `legacy-${await digest(canonical({ sourceId: input.sourceId, key: entry.key, completed: entry.completed }))}`;
    const seen = state.adjustments.has(stableId);
    if (!seen) {
      queueInsert(statements, 'legacy_adjustments', ['adjustment_id', 'source_id', 'legacy_key', 'completed', 'created_at'], [stableId, input.sourceId, entry.key, Number(entry.completed), now]);
      state.adjustments.add(stableId);
    }
    if (entry.completed) {
      if (!seen && ![...state.records.values()].some(value => value.program === entry.program && value.date === entry.date && !value.revoked)) {
        const value = { id: stableId, program: entry.program, date: entry.date, finishedAt: null, source: 'manual', timeZone: null, revoked: false, revokedAt: null };
        putRecord(env.DB, statements, state, value, now, input.operationId);
        adjustment(env.DB, statements, 'manual', stableId, value, now); result.manualRecordIds.push(ref(value));
      }
    } else {
      for (const value of recordsToImport.filter(value => value.program === entry.program && value.date === entry.date)) {
        const k = keyFor(value.program, value.id), existing = state.records.get(k);
        if (added.has(k)) {
          adjustment(env.DB, statements, 'revoke', `revoke-${await digest(`${stableId}:${value.program}:${value.id}`)}`, existing, now);
          result.revokedRecordIds.push(ref(value));
        } else if (!seen && originalRecords.has(k)) result.conflicts.push({ ...ref(value), date: entry.date, reason: 'existing_record_not_revoked' });
      }
    }
  }
  statements.push(env.DB.prepare('INSERT INTO legacy_imports (operation_id, source_id, source_hash, raw_payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(input.operationId, input.sourceId, await digest(canonical({ records: input.records, overrides: input.overrides, progress: input.progress.map(({ writerToken, ...entry }) => entry) })), JSON.stringify({ records: input.records, overrides: input.overrides, progress: input.progress.map(({ writerToken, ...entry }) => entry) }), JSON.stringify(result), now));
  return result;
}
async function prepare(env, input, state, currentTime) {
  const statements = [], now = new Date(currentTime).toISOString();
  const response = { ok: true, operationId: input.operationId };
  if (input.type === 'import') {
    response.import = await prepareImport(env, input, state, statements, now, currentTime);
    return { statements, response };
  }
  program(input.program);
  if (input.type === 'manual') {
    const value = record(input.record, input.program, 'manual', currentTime);
    assertUnique(value, state.records);
    if (state.sessions.has(keyFor(value.program, value.id))) fail(409, 'session_exists', '同标识训练已存在。');
    putRecord(env.DB, statements, state, value, now); adjustment(env.DB, statements, 'manual', input.operationId, value, now); response.record = value;
  } else if (input.type === 'revoke') {
    id(input.recordId, '记录标识');
    const value = state.records.get(keyFor(input.program, input.recordId));
    if (!value) fail(404, 'record_missing', '需要撤销的记录不存在。');
    if (!value.revoked) adjustment(env.DB, statements, 'revoke', input.operationId, value, now);
    response.record = value;
  } else {
    id(input.sessionId, '训练标识');
    const k = keyFor(input.program, input.sessionId), previous = state.sessions.get(k);
    let session;
    if (input.type === 'create') {
      token(input.writerToken);
      const value = snapshot(input.snapshot, input.program, input.sessionId, currentTime);
      assertInput(value.state !== 'finished', '新训练不能以完成状态创建。');
      if (previous) sessionConflict(previous, 'session_exists', '同标识训练已存在，原进度未改动。');
      if (state.records.has(k)) fail(409, 'record_exists', '此训练已有完成记录。');
      session = { id: input.sessionId, program: input.program, status: 'active', snapshot: value, revision: 1, writerEpoch: 1, writerHash: await digest(input.writerToken), updatedAt: now };
      putSession(env.DB, statements, state, session, true);
    } else if (input.type === 'claim') {
      revision(input.expectedRevision); assertActive(previous);
      if (previous.revision !== input.expectedRevision) sessionConflict(previous);
      session = { ...previous, revision: previous.revision + 1, writerEpoch: previous.writerEpoch + 1, updatedAt: now, snapshot: { ...previous.snapshot, state: previous.snapshot.state === 'ready' ? 'ready' : 'paused' } };
      session.writerHash = await digest(await claimToken(env, input.operationId, session));
      putSession(env.DB, statements, state, session); response.issuedWriter = true;
    } else {
      await assertWriter(previous, input);
      session = { ...previous, revision: previous.revision + 1, updatedAt: now };
      if (input.type === 'abandon') session.status = 'abandoned';
      else {
        session.snapshot = snapshot(input.snapshot, input.program, input.sessionId, currentTime);
        if (session.snapshot.index < previous.snapshot.index) sessionConflict(previous, 'progress_regression', '进度不能退回已执行的训练阶段。');
        if (input.type === 'complete') {
          assertInput(session.snapshot.state === 'finished', '完成操作必须提交终态进度。');
          const value = record(input.record, input.program, 'training', currentTime);
          assertInput(value.id === input.sessionId && sameRecord(value, session.snapshot.completion), '完成记录与终态进度不一致。');
          assertUnique(value, state.records); putRecord(env.DB, statements, state, value, now); session.status = 'completed'; response.record = value;
        } else assertInput(session.snapshot.state !== 'finished', '终态进度必须使用完成操作保存。');
      }
      putSession(env.DB, statements, state, session);
    }
    response.session = publicSession(session);
  }
  return { statements, response };
}
async function replay(env, row, hash) {
  if (row.request_hash !== hash) fail(409, 'operation_id_reused', '同一操作标识不能提交不同内容。');
  return hydrateResponse(env, JSON.parse(row.response));
}
async function hydrateResponse(env, saved) {
  if (!saved.issuedWriter) return saved;
  const { issuedWriter, ...response } = saved;
  return { ...response, writerToken: await claimToken(env, saved.operationId, saved.session) };
}
export async function applyOperation(env, raw, now = Date.now()) {
  const input = operation(raw);
  let serialized;
  try { serialized = canonical(input); } catch { fail(400, 'invalid_input', '请求结构过于复杂。'); }
  const hash = await digest(serialized);
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = await env.DB.prepare('SELECT request_hash, response FROM operation_log WHERE operation_id = ?').bind(input.operationId).first();
    if (old) return replay(env, old, hash);
    const state = await readState(env.DB), expectedGlobalRevision = state.revision;
    let prepared;
    try { prepared = await prepare(env, input, state, now); } catch (error) {
      // A duplicate may have committed after our first log read but before this state read.
      const saved = await env.DB.prepare('SELECT request_hash, response FROM operation_log WHERE operation_id = ?').bind(input.operationId).first();
      if (saved) return replay(env, saved, hash);
      throw error;
    }
    const { statements, response } = prepared;
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO write_guards (operation_id, valid) SELECT ?, CASE WHEN revision = ? THEN 1 ELSE 0 END FROM app_state WHERE id = 1').bind(input.operationId, expectedGlobalRevision),
        ...compileStatements(env.DB, statements),
        env.DB.prepare('UPDATE app_state SET revision = revision + 1 WHERE id = 1'),
        env.DB.prepare('INSERT INTO operation_log (operation_id, request_hash, response, created_at) VALUES (?, ?, ?, ?)').bind(input.operationId, hash, JSON.stringify(response), new Date(now).toISOString()),
        env.DB.prepare('DELETE FROM write_guards WHERE operation_id = ?').bind(input.operationId)
      ]);
      return hydrateResponse(env, response);
    } catch (error) {
      // Another request may have committed between the consistent read and this transaction.
      // Failed CHECK / UNIQUE aborts every statement, including any record insertion.
      const saved = await env.DB.prepare('SELECT request_hash, response FROM operation_log WHERE operation_id = ?').bind(input.operationId).first();
      if (saved) return replay(env, saved, hash);
      const current = await env.DB.prepare('SELECT revision FROM app_state WHERE id = 1').first();
      if (current.revision === expectedGlobalRevision) throw error;
      // Re-read and revalidate the original CAS on retry; never silently advance a client revision.
    }
  }
  fail(409, 'write_contention', '另一设备正在保存，请保留本地进度后重试。');
}
