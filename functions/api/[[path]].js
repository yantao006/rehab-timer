import { ApiError, fail } from '../_lib/validation.js';
import { configuration, logout, origin } from '../_lib/auth.js';
import { applyOperation, stateResponse } from '../_lib/storage.js';
const MAX_BODY = 1024 * 1024;
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'json_required', '请求必须为 JSON。');
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) fail(413, 'body_too_large', '请求数据过大，请分批导入。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json', '请求内容为空。');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); fail(413, 'body_too_large', '请求数据过大，请分批导入。'); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch { fail(400, 'invalid_json', '请求不是有效 JSON。'); }
}
export async function onRequest(context) {
  try {
    const { request } = context;
    configuration(context.env); origin(request);
    // Use a primary-first D1 session when available, including read-after-write retries.
    const env = { ...context.env, DB: context.env.DB.withSession?.('first-primary') || context.env.DB };
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if ((path === '/api/login' || path === '/api/logout') && request.method === 'POST') return json({ ok: true, environment: env.APP_ENV }, 200, { 'Set-Cookie': logout() });
    if (path === '/api/state' && request.method === 'GET') return json(await stateResponse(env));
    if (path === '/api/operation' && request.method === 'POST') return json(await applyOperation(env, await body(request)));
    return json({ ok: false, error: { code: 'not_found', message: '接口不存在。' } }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ ok: false, error: { code: error.code, message: error.message }, ...error.extra }, error.status);
    console.error('rehab-api-failure', error?.name || 'Error');
    return json({ ok: false, error: { code: 'storage_unavailable', message: '云端暂时无法保存，请保留本地进度后重试。' } }, 503);
  }
}
