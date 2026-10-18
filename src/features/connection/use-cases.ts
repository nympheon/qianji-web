import { passwordLoginSchema } from './contract';
import type { Env } from '../../worker/env';

const headers = { 'cache-control': 'no-store' };
const errors: Record<string, { status: number; message: string }> = {
  CREDENTIAL_KEY_REQUIRED: { status: 503, message: '请先配置凭证加密Secret' },
  CREDENTIAL_KEY_INVALID: { status: 503, message: '凭证加密Secret格式无效' },
  CREDENTIAL_DECRYPT_FAILED: { status: 503, message: '无法解密已存凭证，请恢复原Secret或重新登录' },
  INVALID_LOGIN_INPUT: { status: 400, message: '请输入有效的手机号或邮箱和密码' },
  QIANJI_NETWORK_ERROR: { status: 502, message: '无法连接钱迹服务' },
  QIANJI_TIMEOUT: { status: 504, message: '钱迹登录请求超时，请检查连接状态' },
  QIANJI_HTTP_ERROR: { status: 502, message: '钱迹返回HTTP错误' },
  QIANJI_BUSINESS_ERROR: { status: 400, message: '钱迹未接受登录请求' },
  QIANJI_SESSION_EXPIRED: { status: 401, message: '钱迹连接需要重新登录' },
  QIANJI_RESTRICTED: { status: 403, message: '钱迹限制当前操作' },
  QIANJI_RESPONSE_INVALID: { status: 502, message: '钱迹登录响应格式发生变化' },
};
function errorResponse(code: string, status: number, message: string): Response {
  return Response.json({ status: 'error', data: null, freshness: null, error: { code, message } }, { status, headers });
}
export async function passwordLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return errorResponse('INVALID_LOGIN_INPUT', 400, '请发送JSON登录信息');
  let input: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > 8192) { await reader.cancel(); return errorResponse('BODY_TOO_LARGE', 413, '登录信息超出长度限制'); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch { return errorResponse('INVALID_LOGIN_INPUT', 400, '登录信息格式无效'); }
  const parsed = passwordLoginSchema.safeParse(input);
  if (!parsed.success) return errorResponse('INVALID_LOGIN_INPUT', 400, '请输入有效的手机号或邮箱和密码');
  try {
    const view = await env.QIANJI_STATE.getByName('personal').login(parsed.data);
    return Response.json({ status: 'ready', data: view, freshness: null }, { headers });
  } catch (error) {
    // RPC preserves Error.message, not custom properties. Only known stable codes cross HTTP.
    const code = error instanceof Error ? /^([A-Z][A-Z0-9_]+):/.exec(error.message)?.[1] : undefined;
    const mapped = code ? errors[code] : undefined;
    return mapped && code ? errorResponse(code, mapped.status, mapped.message) : errorResponse('CONNECTION_ERROR', 500, '连接操作未能完成');
  }
}
