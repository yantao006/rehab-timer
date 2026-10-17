import { ApiError, assertInput, fail, object } from './validation.js';
import { digest, equal, hmac } from './crypto.js';
const COOKIE = 'rehab_session';
const MAX_AGE = 30 * 24 * 3600;
export function configuration(env) {
  if (!env.DB || !['production', 'preview'].includes(env.APP_ENV) || typeof env.SHARED_PASSPHRASE !== 'string' || env.SHARED_PASSPHRASE.length < 8 || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) fail(503, 'not_configured', '云端暂未配置完成。');
}
export function origin(request) {
  const url = new URL(request.url), supplied = request.headers.get('Origin');
  if (url.protocol !== 'https:' || (supplied && supplied !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'invalid_origin', '只允许从本站访问训练数据。');
  if (request.method !== 'GET' && supplied !== url.origin) fail(403, 'invalid_origin', '写入操作必须来自本站。');
}
async function sign(env, body) {
  // Changing the shared passphrase invalidates previously issued cookies, too.
  return hmac(env.SESSION_SECRET, `session:${body}:${await digest(env.SHARED_PASSPHRASE)}`);
}
export async function authenticated(request, env, now = Date.now()) {
  const raw = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw || raw.length > 300) fail(401, 'authentication_required', '请输入共享访问口令。');
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d+$/.test(parts[1]) || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) fail(401, 'authentication_required', '访问凭证已失效，请重新输入口令。');
  const expires = Number(parts[1]), current = Math.floor(now / 1000);
  if (expires < current || expires > current + MAX_AGE + 60 || !equal(parts[3], await sign(env, parts.slice(0, 3).join('.')))) fail(401, 'authentication_required', '访问凭证已失效，请重新输入口令。');
}
export async function login(request, env, body, now = Date.now()) {
  assertInput(object(body) && typeof body.passphrase === 'string' && body.passphrase.length <= 512, '口令格式不正确。');
  // Hash IPs with the server secret; retain no plaintext IP or submitted passphrase.
  const window = Math.floor(now / 900000), bucket = await hmac(env.SESSION_SECRET, `login:${request.headers.get('CF-Connecting-IP') || 'unknown'}:${window}`);
  const [count] = await env.DB.batch([
    env.DB.prepare('INSERT INTO login_limits (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts').bind(bucket, (window + 1) * 900000),
    env.DB.prepare('DELETE FROM login_limits WHERE expires_at < ?').bind(now - 900000)
  ]);
  if (count.results[0].attempts > 10) throw new ApiError(429, 'login_limited', '尝试过于频繁，请稍后再试。');
  if (!equal(await digest(body.passphrase), await digest(env.SHARED_PASSPHRASE))) fail(401, 'invalid_passphrase', '共享访问口令不正确。');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const value = `v1.${Math.floor(now / 1000) + MAX_AGE}.${random}`;
  return `${COOKIE}=${value}.${await sign(env, value)}; Path=/api; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}
export function logout() { return `${COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`; }
