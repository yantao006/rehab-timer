const encoder = new TextEncoder();
export function canonical(value, depth = 0) {
  if (depth > 12) throw new RangeError('JSON input is too deeply nested');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
export async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export const claimToken = (env, operationId, session) => hmac(env.SESSION_SECRET, `writer:${operationId}:${session.program}:${session.id}:${session.writerEpoch}`);
