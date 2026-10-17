export const PLAN_REVISION = 2;
export const PROGRAMS = ['five-stage-v1', 'lower-limb-joints-v1'];
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}
export const fail = (status, code, message, extra) => { throw new ApiError(status, code, message, extra); };
const requireValid = (value, message) => { if (!value) fail(400, 'invalid_input', message); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fields(value, allowed, label) { requireValid(object(value) && Object.keys(value).every(key => allowed.includes(key)), `${label}包含不支持的字段。`); }
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
export function id(value, label = '标识') { requireValid(validId(value), `${label}格式不正确。`); return value; }
export function program(value) { requireValid(PROGRAMS.includes(value), '训练计划不正确。'); return value; }
export function token(value) { requireValid(typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value), '写入令牌格式不正确。'); return value; }
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
export function date(value, now = Date.now()) {
  // UTC+14 bounds the latest civil date worldwide, without changing the supplied completion date.
  requireValid(validDate(value) && value <= new Date(now + 14 * 3600000).toISOString().slice(0, 10), '完成日期不正确或在未来。');
  return value;
}
export function timeZone(value) {
  if (value == null) return null;
  requireValid(typeof value === 'string' && value.length <= 100, '时区格式不正确。');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { fail(400, 'invalid_input', '时区无效。'); }
  return value;
}
function timestamp(value, now) {
  requireValid(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 300000, '完成时间不正确或在未来。');
  return value;
}
export function record(value, expectedProgram, source, now = Date.now(), legacy = false) {
  fields(value, ['version', 'id', 'program', 'date', 'finishedAt', 'source', 'timeZone'], '完成记录');
  id(value.id, '记录标识');
  date(value.date, now);
  requireValid(legacy ? value.version === 1 : value.program === expectedProgram && value.source === source, '完成记录计划或来源不正确。');
  const zone = timeZone(value.timeZone);
  const finishedAt = source === 'manual' ? null : timestamp(value.finishedAt, now);
  if (source === 'manual') requireValid(value.finishedAt == null, '手工补记不能伪造完成时间。');
  if (finishedAt) {
    const finish = Date.parse(finishedAt);
    const utcMidday = Date.parse(`${value.date}T12:00:00Z`);
    requireValid(finish >= utcMidday - 26 * 3600000 && finish <= utcMidday + 24 * 3600000, '完成日期与时间不一致。');
    if (zone) {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(finish));
      const get = type => parts.find(part => part.type === type).value;
      requireValid(`${get('year')}-${get('month')}-${get('day')}` === value.date, '完成日期与时区不一致。');
    }
  }
  return { id: value.id, program: expectedProgram, date: value.date, finishedAt, source, timeZone: zone, revoked: false, revokedAt: null };
}
export function schedule(programId, planRevision = PLAN_REVISION) {
  const joint = programId === PROGRAMS[1];
  const items = [{ stage: 0, kind: 'prep', seconds: 30 }];
  for (let stage = 0; stage < 4; stage++) {
    for (let group = 1; group <= 2; group++) {
      for (let rep = 1; rep <= 6; rep++) {
        items.push({ stage, kind: 'work', seconds: 15 });
        if (rep < 6) items.push({ stage, kind: 'rest', seconds: 5 });
      }
      if (group === 1) items.push({ stage, kind: 'group-rest', seconds: 60 });
    }
    if (joint) items.push({ stage, kind: 'stage-rest', seconds: 60 });
  }
  if (joint) for (let i = 0; i < 2; i++) items.push({ stage: 4, kind: 'manual', seconds: 0 });
  else for (let round = 1; round <= 4; round++) {
    items.push({ stage: 4, kind: 'work', seconds: 30 }, { stage: 4, kind: 'stretch', seconds: 30 });
    if (planRevision === PLAN_REVISION && round < 4) items.push({ stage: 4, kind: 'round-rest', seconds: 30 });
  }
  return items;
}
export function snapshot(value, expectedProgram, sessionId, now = Date.now()) {
  fields(value, ['version', 'planRevision', 'program', 'unitMs', 'id', 'index', 'remaining', 'state', 'completion'], '进度快照');
  const sourceRevision = value.planRevision === undefined ? 1 : value.planRevision;
  requireValid([1, PLAN_REVISION].includes(sourceRevision), '训练计划版本不受支持。');
  const plan = schedule(expectedProgram, sourceRevision), item = plan[value.index];
  requireValid(value.version === 1 && value.program === expectedProgram && value.unitMs === 1000 && value.id === sessionId && Number.isInteger(value.index) && item && Number.isFinite(value.remaining) && value.remaining >= 0 && value.remaining <= item.seconds * 1000 && ['cue', 'running', 'paused', 'ready', 'manual', 'finished'].includes(value.state), '进度快照与正式训练规则不符。');
  if (value.state === 'finished') {
    requireValid(value.index === plan.length - 1 && value.remaining === 0, '训练尚未到达完成阶段。');
    const completion = record(value.completion, expectedProgram, 'legacy', now, true);
    requireValid(completion.id === sessionId, '完成记录与训练标识不一致。');
  } else requireValid(value.completion === null && (item.kind === 'manual' || value.remaining > 0), '未完成训练的快照不正确。');
  requireValid(value.state !== 'manual' || item.kind === 'manual', '只有手工计次阶段可使用手工状态。');
  if (value.state === 'ready') requireValid(value.index > 0 && (plan[value.index - 1].stage !== item.stage || (expectedProgram === PROGRAMS[1] && value.index === plan.length - 1 && item.kind === 'manual')) && value.remaining === item.seconds * 1000, '项间就位快照不正确。');
  // Copy only domain data; deadlines, device identity and arbitrary input never enter the database.
  return { version: 1, planRevision: PLAN_REVISION, program: expectedProgram, unitMs: 1000, id: sessionId, index: sourceRevision === 1 && expectedProgram === PROGRAMS[0] && value.index >= 93 ? value.index + Math.floor((value.index - 93) / 2) : value.index, remaining: value.remaining, state: value.state, completion: value.completion === null ? null : { version: 1, id: value.completion.id, date: value.completion.date, finishedAt: value.completion.finishedAt } };
}
export function revision(value) { requireValid(Number.isSafeInteger(value) && value >= 1, '训练版本不正确。'); return value; }
export function operation(value) {
  requireValid(object(value), '操作格式不正确。'); id(value.operationId, '操作标识');
  requireValid(['create', 'progress', 'complete', 'abandon', 'claim', 'manual', 'revoke', 'import'].includes(value.type), '操作类型不正确。');
  const inputs = {
    create: ['program', 'sessionId', 'snapshot', 'writerToken'],
    progress: ['program', 'sessionId', 'snapshot', 'expectedRevision', 'writerEpoch', 'writerToken'],
    complete: ['program', 'sessionId', 'snapshot', 'record', 'expectedRevision', 'writerEpoch', 'writerToken'],
    abandon: ['program', 'sessionId', 'expectedRevision', 'writerEpoch', 'writerToken'],
    claim: ['program', 'sessionId', 'expectedRevision'],
    manual: ['program', 'record'], revoke: ['program', 'recordId'],
    import: ['sourceId', 'records', 'overrides', 'progress']
  };
  fields(value, ['operationId', 'type', ...inputs[value.type]], '操作');
  return value;
}
export function legacyKey(key, programId, suffix) {
  const prefix = programId === PROGRAMS[0] ? 'rehab-timer:v1' : 'rehab-timer:v1:joint';
  requireValid(key === `${prefix}:${suffix}`, '只能导入正式版本的原始存储键。');
}
export function list(value, max, label) { requireValid(Array.isArray(value) && value.length <= max, `${label}格式或数量不正确。`); return value; }
export const assertInput = requireValid;
