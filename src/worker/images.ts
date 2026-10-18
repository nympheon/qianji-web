import type { Env } from './env';
import { imageReferenceSchema } from '../features/attachments/contract';
import { MAX_IMAGE_BYTES } from '../features/attachments/upload';
/** Known official media origins only. No forwarded credentials, cookies or redirect following. */
export async function handleImageHttp(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const input = imageReferenceSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams)); if (!input.success) return new Response(null, { status: 400 });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try { const source = await env.QIANJI_STATE.getByName('personal').imageSource(input.data), response = await fetch(source, { method: request.method, redirect: 'manual', signal: controller.signal, headers: { accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif' } }), type = response.headers.get('content-type')?.split(';')[0]?.trim(); if (!response.ok || !type || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } });
    const headers = { 'content-type': type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' }; if (request.method === 'HEAD') return new Response(null, { headers });
    const reader = response.body?.getReader(); if (!reader) return new Response(null, { status: 502 }); let size = 0; const chunks: Uint8Array[] = []; try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(part.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return new Response(bytes, { headers });
  } catch { return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } }); } finally { clearTimeout(timer); }
}
