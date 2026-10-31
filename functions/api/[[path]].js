import { ApiError, fail } from '../_lib/validation.js';
import { listRecords, putRecord, revokeRecord } from '../_lib/records.js';
const MAX_BODY = 16 * 1024;
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function origin(request) {
  const url = new URL(request.url), supplied = request.headers.get('Origin');
  if (url.protocol !== 'https:' || (supplied && supplied !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'invalid_origin', '只允许从本站访问训练数据。');
  if (request.method !== 'GET' && supplied !== url.origin) fail(403, 'invalid_origin', '写入操作必须来自本站。');
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'json_required', '请求必须为 JSON。');
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'body_too_large', '请求数据过大。');
  try { return JSON.parse(text); } catch { fail(400, 'invalid_json', '请求不是有效 JSON。'); }
}
export async function onRequest(context) {
  try {
    const { request } = context;
    if (!context.env.DB || !['production', 'preview'].includes(context.env.APP_ENV)) fail(503, 'not_configured', '服务暂未配置完成。');
    origin(request);
    const env = { ...context.env, DB: context.env.DB.withSession?.('first-primary') || context.env.DB };
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if (path === '/api/records' && request.method === 'GET') return json(await listRecords(env));
    if (path === '/api/records' && request.method === 'POST') return json(await putRecord(env, await body(request)));
    if (path === '/api/records/revoke' && request.method === 'POST') return json(await revokeRecord(env, await body(request)));
    // Pages cached from the previous version: tell them to reload instead of failing silently.
    if (['/api/state', '/api/operation', '/api/login', '/api/logout'].includes(path)) return json({ ok: false, error: { code: 'gone', message: '页面已更新，请刷新。' } }, 410);
    return json({ ok: false, error: { code: 'not_found', message: '接口不存在。' } }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
    console.error('rehab-api-failure', error?.name || 'Error');
    return json({ ok: false, error: { code: 'storage_unavailable', message: '记录暂时无法保存。' } }, 503);
  }
}
