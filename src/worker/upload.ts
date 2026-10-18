import type { Env } from './env';
import { actionSchemas } from '../contracts/actions';
import { dynamicHeaders } from './http';
import { MAX_IMAGE_BYTES } from '../features/attachments/upload';
const invalid = (code: string, message: string, status: number) => Response.json({ status: 'error', data: null, freshness: null, error: { code, message } }, { status, headers: dynamicHeaders });
export async function handleUploadHttp(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...dynamicHeaders, allow: 'POST' } });
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'multipart/form-data') return invalid('MULTIPART_REQUIRED', '请通过图片文件表单上传', 415);
  const reader = request.body?.getReader(); if (!reader) return invalid('IMAGE_FILE_REQUIRED', '请选择图片文件', 400); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_IMAGE_BYTES + 65536) { await reader.cancel(); return invalid('IMAGE_TOO_LARGE', '单张处理后的图片需在8MiB以内', 413); } chunks.push(part.value); } } catch { return invalid('UPLOAD_BODY_INVALID', '图片文件读取失败', 400); } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let form: FormData; try { form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData(); } catch { return invalid('UPLOAD_FORM_INVALID', '图片上传表单无效', 400); }
  const files = form.getAll('file'), file = files[0]; if (files.length !== 1 || !(file instanceof File) || !file.size || file.size > MAX_IMAGE_BYTES || [...form.keys()].some((key) => !['file', 'purpose', 'requestId', 'draftKey'].includes(key))) return invalid('IMAGE_FILE_INVALID', '请选择一张8MiB以内图片，并使用明确的用途及原请求键', 400);
  const input = actionSchemas['attachments.upload'].safeParse({ purpose: form.get('purpose'), mime: file.type, requestId: form.get('requestId'), ...(form.has('draftKey') ? { draftKey: form.get('draftKey') } : {}) }); if (!input.success) return invalid('UPLOAD_INPUT_INVALID', '图片用途、格式或请求键无效', 400);
  const fileBytes = new Uint8Array(await file.arrayBuffer()), parts: string[] = []; for (let start = 0; start < fileBytes.length; start += 32768) parts.push(String.fromCharCode(...fileBytes.subarray(start, start + 32768))); const dataBase64 = btoa(parts.join(''));
  const reply = await env.QIANJI_STATE.getByName('personal').call('attachments.upload', { ...input.data, dataBase64 }); return new Response(reply, { headers: { ...dynamicHeaders, 'content-type': 'application/json; charset=utf-8' } });
}
