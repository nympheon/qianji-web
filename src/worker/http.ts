import { actionRequestSchema } from '../contracts/actions';
import type { Env } from './env';
export const dynamicHeaders = { 'cache-control': 'no-store' };
function invalid(code: string, message: string, status: number) { return Response.json({ status: 'error', data: null, freshness: null, error: { code, message } }, { status, headers: dynamicHeaders }); }
export async function handleActionHttp(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...dynamicHeaders, allow: 'POST' } });
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return invalid('JSON_REQUIRED', '请发送JSON操作参数', 415);
  let value: unknown;
  try {
    const reader = request.body?.getReader(); if (!reader) return invalid('INVALID_REQUEST', '操作格式无效', 400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 65_536) { await reader.cancel(); return invalid('BODY_TOO_LARGE', '操作参数过长', 413); } chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return invalid('INVALID_REQUEST', '操作格式无效', 400); }
  const parsed = actionRequestSchema.safeParse(value); if (!parsed.success) return invalid('INVALID_REQUEST', '操作格式无效', 400);
  const reply = await env.QIANJI_STATE.getByName('personal').call(parsed.data.action, parsed.data.input, parsed.data.meta);
  return new Response(reply, { headers: { ...dynamicHeaders, 'content-type': 'application/json; charset=utf-8' } });
}
