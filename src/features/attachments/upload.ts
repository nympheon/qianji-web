import type { ActorScope, Clock } from '../../shared/model';
import type { QianjiClient } from '../../protocol/client';
import { ProtocolError } from '../../protocol/errors';
import { DomainError } from '../../shared/errors';
import { asBillObject, numericText } from '../../shared/bill-wire';
export type ImagePurpose = 'bill' | 'cover' | 'category';
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const urlBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
/** Official Qiniu SDK ETag: SHA1 per4MiB, 0x16 single or 0x96 aggregate. */
export async function qiniuEtag(bytes: Uint8Array): Promise<string> {
  const digests: Uint8Array[] = []; for (let offset = 0; offset < bytes.length || offset === 0; offset += 4 * 1024 * 1024) digests.push(new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes.subarray(offset, offset + 4 * 1024 * 1024)))));
  let hash = digests[0]!; if (digests.length > 1) { const all = new Uint8Array(digests.length * 20); digests.forEach((digest, index) => all.set(digest, index * 20)); hash = new Uint8Array(await crypto.subtle.digest('SHA-1', all)); }
  const result = new Uint8Array(21); result[0] = digests.length === 1 ? 0x16 : 0x96; result.set(hash, 1); return urlBase64(result);
}
interface Credential { token: string; accessKey: string; bucket: string; keyScope: string | null; prefixScope: boolean; expiresSec: number }
export class OfficialImageTransport {
  readonly #tokens = new Map<string, Credential>();
  readonly #pending = new Map<string, Promise<Credential>>();
  readonly #regions = new Map<string, { host: string; expiresMs: number }>();
  constructor(private readonly dependencies: { client: QianjiClient; clock: Clock; generation(): number; fetch?: (url: string, init: RequestInit) => Promise<Response> }) {}
  private async credential(scope: ActorScope, purpose: ImagePurpose): Promise<Credential> {
    const dt = purpose === 'bill' ? 1 : 2, id = JSON.stringify([scope.uid, scope.connectionEpoch, this.dependencies.generation(), dt]), current = this.#tokens.get(id), now = Math.floor(this.dependencies.clock.nowMs() / 1000);
    if (current && current.expiresSec - now > 60) return current; const pending = this.#pending.get(id); if (pending) return pending;
    const request = (async () => {
      const reply = await this.dependencies.client.request('common.uploadToken', { uid: scope.uid, dt }, scope), raw = asBillObject(reply.data), expires = Number(numericText(raw.expireAt, '')), token = raw.v;
      if (typeof token !== 'string' || token.length > 16384 || !Number.isSafeInteger(expires)) throw new DomainError('UPLOAD_TOKEN_INVALID', '官方上传凭证格式无法核对');
      const parts = token.split(':'); if (parts.length !== 3 || !/^[\w-]+$/.test(parts[0]!)) throw new DomainError('UPLOAD_TOKEN_INVALID', '官方上传凭证格式无法核对');
      let policy: { scope?: unknown; deadline?: unknown; isPrefixalScope?: unknown }; try { policy = JSON.parse(atob(parts[2]!.replaceAll('-', '+').replaceAll('_', '/'))); } catch { throw new DomainError('UPLOAD_TOKEN_INVALID', '官方上传凭证策略无法识别'); }
      if (typeof policy.scope !== 'string' || !Number.isSafeInteger(policy.deadline)) throw new DomainError('UPLOAD_TOKEN_INVALID', '上传凭证缺少空间或有效期'); const split = policy.scope.indexOf(':'), bucket = split < 0 ? policy.scope : policy.scope.slice(0, split), keyScope = split < 0 ? null : policy.scope.slice(split + 1), expiresSec = Math.min(expires, Number(policy.deadline));
      if (!/^[\w-]{1,200}$/.test(bucket) || expiresSec - now <= 60) throw new DomainError('UPLOAD_TOKEN_EXPIRING', '官方上传凭证即将失效，请稍后重新开始上传');
      const value = { token, accessKey: parts[0]!, bucket, keyScope, prefixScope: policy.isPrefixalScope === 1, expiresSec }; this.#tokens.set(id, value); if (this.#tokens.size > 8) this.#tokens.delete(this.#tokens.keys().next().value!); return value;
    })(); this.#pending.set(id, request); try { return await request; } finally { if (this.#pending.get(id) === request) this.#pending.delete(id); }
  }
  private async json(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    try { const response = await (this.dependencies.fetch ?? fetch)(url, { ...init, redirect: 'manual', signal: controller.signal }); if (!response.ok) throw new ProtocolError('UPLOAD_HTTP_ERROR', '官方图片存储返回错误，保留原操作核查', 'http', 'unknown', { httpStatus: response.status }); const reader = response.body?.getReader(); if (!reader) throw new Error('empty'); let length = 0; const chunks: Uint8Array[] = []; try { while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 65536) { await reader.cancel(); throw new Error('large'); } chunks.push(item.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return JSON.parse(new TextDecoder().decode(bytes)); }
    catch (error) { if (error instanceof DomainError) throw error; throw new ProtocolError('UPLOAD_NETWORK_ERROR', '图片上传结果需要核查，请保留原操作', 'network', 'unknown'); } finally { clearTimeout(timer); }
  }
  private async host(credential: Credential) {
    const key = `${credential.accessKey}:${credential.bucket}`, cached = this.#regions.get(key), now = this.dependencies.clock.nowMs(); if (cached && cached.expiresMs > now) return cached.host;
    const query = new URLSearchParams({ ak: credential.accessKey, bucket: credential.bucket }), value = await this.json(`https://api.qiniu.com/v2/query?${query}`, { method: 'GET' });
    if (!value || typeof value !== 'object' || !('up' in value)) throw new DomainError('UPLOAD_REGION_INVALID', '官方上传区域无法识别'); const up = value.up; if (!up || typeof up !== 'object' || !('acc' in up) || !up.acc || typeof up.acc !== 'object' || !('main' in up.acc) || !Array.isArray(up.acc.main)) throw new DomainError('UPLOAD_REGION_INVALID', '官方上传区域缺少主线路');
    const host = up.acc.main[0]; if (typeof host !== 'string' || !/^(?:[\w-]+\.)*qiniup\.com$/.test(host)) throw new DomainError('UPLOAD_REGION_INVALID', '官方上传主机不在已核对的存储域名中'); const ttl = 'ttl' in value && typeof value.ttl === 'number' && value.ttl > 0 ? Math.min(value.ttl, 3600) : 300, url = `https://${host}/`; this.#regions.set(key, { host: url, expiresMs: now + ttl * 1000 }); return url;
  }
  async upload(scope: ActorScope, input: { purpose: ImagePurpose; key: string; bytes: Uint8Array; mime: string; etag: string }): Promise<{ key: string; hash: string }> {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_IMAGE_BYTES) throw new DomainError('UPLOAD_SIZE_INVALID', '单张处理后的图片需要在8MiB以内');
    let host: string, form: FormData;
    try { const credential = await this.credential(scope, input.purpose); if (credential.keyScope !== null && (credential.prefixScope ? !input.key.startsWith(credential.keyScope) : input.key !== credential.keyScope)) throw new DomainError('UPLOAD_KEY_SCOPE_INVALID', '图片对象名超出官方凭证允许范围'); host = await this.host(credential); form = new FormData(); form.set('token', credential.token); form.set('key', input.key); form.set('file', new Blob([new Uint8Array(input.bytes).buffer], { type: input.mime }), input.purpose === 'category' ? 'image.png' : 'image.jpg'); }
    catch (error) { throw new ProtocolError(error instanceof DomainError ? error.code : 'UPLOAD_PREFLIGHT_FAILED', '图片尚未上传，官方凭证或区域暂不可用', error instanceof ProtocolError ? error.kind : 'protocol', 'not-sent'); }
    const value = await this.json(host, { method: 'POST', body: form }); if (!value || typeof value !== 'object' || !('key' in value) || value.key !== input.key || !('hash' in value) || value.hash !== input.etag) throw new DomainError('UPLOAD_RECEIPT_INVALID', '官方上传回执的对象名或校验值不匹配，保留原操作核查'); return { key: input.key, hash: input.etag };
  }
  async preflight(scope: ActorScope, purpose: ImagePurpose, key: string): Promise<void> { const credential = await this.credential(scope, purpose); if (credential.keyScope !== null && (credential.prefixScope ? !key.startsWith(credential.keyScope) : key !== credential.keyScope)) throw new DomainError('UPLOAD_KEY_SCOPE_INVALID', '图片对象名超出官方凭证允许范围'); await this.host(credential); }
}
export async function proveOfficialImage(url: string, etag: string): Promise<boolean> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try { const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal }); if (!response.ok || !response.body) return false; const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0; try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return false; } chunks.push(item.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return await qiniuEtag(bytes) === etag; } catch { return false; } finally { clearTimeout(timer); }
}
