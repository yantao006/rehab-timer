import { fail } from './validation.js';
const COOKIE = 'rehab_session';
export function configuration(env) {
  if (!env.DB || !['production', 'preview'].includes(env.APP_ENV) || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) fail(503, 'not_configured', '云端暂未配置完成。');
}
export function origin(request) {
  const url = new URL(request.url), supplied = request.headers.get('Origin');
  if (url.protocol !== 'https:' || (supplied && supplied !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'invalid_origin', '只允许从本站访问训练数据。');
  if (request.method !== 'GET' && supplied !== url.origin) fail(403, 'invalid_origin', '写入操作必须来自本站。');
}
// Compatibility for cached clients: discard old cookies without issuing credentials.
export function logout() { return `${COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`; }
