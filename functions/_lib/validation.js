export const PROGRAMS = ['five-stage-v1', 'lower-limb-joints-v1'];
export const SOURCES = ['training', 'manual', 'legacy'];
export class ApiError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const requireValid = (value, message) => { if (!value) fail(400, 'invalid_input', message); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fields(value, allowed, label) { requireValid(object(value) && Object.keys(value).every(key => allowed.includes(key)), `${label}包含不支持的字段。`); }
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
export function id(value, label = '标识') { requireValid(validId(value), `${label}格式不正确。`); return value; }
export function program(value) { requireValid(PROGRAMS.includes(value), '训练计划不正确。'); return value; }
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
// A completion record as the page sends it. Manual records never carry an invented finish time.
export function record(value, now = Date.now()) {
  fields(value, ['version', 'id', 'program', 'date', 'finishedAt', 'source', 'timeZone'], '完成记录');
  requireValid(value.version === undefined || value.version === 1, '完成记录版本不正确。');
  id(value.id, '记录标识'); program(value.program); date(value.date, now);
  requireValid(SOURCES.includes(value.source), '完成记录来源不正确。');
  const zone = timeZone(value.timeZone);
  const manual = value.source === 'manual';
  if (manual) requireValid(value.finishedAt == null, '手工补记不能伪造完成时间。');
  const finishedAt = manual ? null : timestamp(value.finishedAt, now);
  if (finishedAt) {
    const finish = Date.parse(finishedAt), utcMidday = Date.parse(`${value.date}T12:00:00Z`);
    requireValid(finish >= utcMidday - 26 * 3600000 && finish <= utcMidday + 24 * 3600000, '完成日期与时间不一致。');
    if (zone) {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(finish));
      const get = type => parts.find(part => part.type === type).value;
      requireValid(`${get('year')}-${get('month')}-${get('day')}` === value.date, '完成日期与时区不一致。');
    }
  }
  return { id: value.id, program: value.program, date: value.date, finishedAt, source: value.source, timeZone: zone };
}
