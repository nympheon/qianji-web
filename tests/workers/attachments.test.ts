import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { ImageConfiguration } from '../../src/features/attachments/configuration';
import { billImagePlan } from '../../src/features/attachments/preprocess';
import { OfficialImageTransport, qiniuEtag } from '../../src/features/attachments/upload';
import { AttachmentRuntime, createAttachmentMutationHandler } from '../../src/features/attachments/use-cases';
import { AttachmentService } from '../../src/features/attachments/service';
import { Coordinator } from '../../src/actor/coordinator';
import { ResourceCache } from '../../src/storage/cache';
import { stringifyWire } from '../../src/shared/wire-json';
import { decodeUpload } from '../../src/features/attachments/metadata';
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
describe('native image preprocessing and configuration', () => {
  it('uses APK long-side priority rather than an invented fit rectangle', () => {
    expect(billImagePlan(4000, 3000)).toMatchObject({ width: 3200, height: 2400, huge: false, quality: 0.8 }); expect(billImagePlan(3000, 2000)).toMatchObject({ width: 2880, height: 1920, huge: false });
  });
  it('retains long or huge image dimensions and applies the exact threshold edges', () => {
    expect(billImagePlan(9000, 3000)).toMatchObject({ width: 9000, height: 3000, huge: true }); expect(billImagePlan(8000, 2000)).toMatchObject({ width: 3200, height: 800, huge: false }); expect(billImagePlan(30000, 30000).huge).toBe(false); expect(billImagePlan(30001, 30001).huge).toBe(true);
  });
  it('takes the bill image count and hosts from official configs while marking native defaults honestly', async () => {
    const app = await createTestApp(), clock = new TestClock(); await app.repository((repository) => { const config = new ImageConfiguration({ repository, clock }); expect(config.read(app.scope)).toMatchObject({ maxBillImages: 6, source: 'apk-default' }); config.applyOfficial(app.scope, { max_bill_image: '9', bill_image_host: 'https://billimg.qianjiapp.com/', pub_image_host: 'https://img.qianjiapp.com/' }); expect(config.read(app.scope)).toMatchObject({ maxBillImages: 9, source: 'qianji' }); });
  });
});
describe('official object upload transport', () => {
  it('reports a readonly region failure as not-sent because the object POST has not started', async () => {
    const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope); upstream.respond(async () => { const expireAt = Math.floor(clock.nowMs() / 1000) + 3600; return Response.json({ ec: 200, data: { v: `ak:signature:${btoa(JSON.stringify({ scope: 'bucket', deadline: expireAt }))}`, expireAt } }); });
    const transport = new OfficialImageTransport({ client: upstream.client, clock, generation: () => 1, fetch: async () => { throw new Error('readonly network failure'); } });
    await expect(transport.upload(app.scope, { purpose: 'bill', key: '_key', bytes: new Uint8Array([1]), mime: 'image/jpeg', etag: 'a'.repeat(28) })).rejects.toMatchObject({ certainty: 'not-sent' });
  });
  async function setup() {
    const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope), providerCalls: { url: string; body: FormData | null }[] = [], bytes = new TextEncoder().encode('hello'), hash = await qiniuEtag(bytes); let responseKey = 'expected-key', responseHash = hash;
    upstream.respond(async () => { const expireAt = Math.floor(clock.nowMs() / 1000) + 3600, policy = btoa(JSON.stringify({ scope: 'test-bucket', deadline: expireAt })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); return new Response(JSON.stringify({ ec: 200, data: { v: `test-access:signature:${policy}`, expireAt } })); });
    const transport = new OfficialImageTransport({ client: upstream.client, clock, generation: () => 1, fetch: async (url, init) => { providerCalls.push({ url, body: init?.body instanceof FormData ? init.body : null }); return url.includes('/v2/query?') ? Response.json({ ttl: 3600, up: { acc: { main: ['upload-z2.qiniup.com'], backup: [] } } }) : Response.json({ key: responseKey, hash: responseHash }); } });
    return { app, clock, upstream, providerCalls, transport, bytes, hash, setResponse(key: string, value: string) { responseKey = key; responseHash = value; } };
  }
  it('matches the official SDK empty-file ETag vector', async () => { expect(await qiniuEtag(new Uint8Array())).toBe('Fto5o-5ea0sNMlW_75VgGJCv2AcJ'); });
  it('uses official bucket-region discovery and keeps the temporary token out of application results', async () => {
    const s = await setup(), result = await s.transport.upload(s.app.scope, { purpose: 'bill', key: 'expected-key', bytes: s.bytes, mime: 'image/jpeg', etag: s.hash }); expect(result).toEqual({ key: 'expected-key', hash: s.hash }); expect(s.providerCalls[0]!.url).toContain('https://api.qiniu.com/v2/query?'); expect(s.providerCalls[1]!.url).toBe('https://upload-z2.qiniup.com/'); expect(s.providerCalls[1]!.body?.get('key')).toBe('expected-key'); expect(new URLSearchParams(s.upstream.calls[0]!.body).get('dt')).toBe('1');
  });
  it('does not reuse a credential within its last60 seconds and keeps dt1 and dt2 caches separate', async () => {
    const s = await setup(), input = { purpose: 'bill' as const, key: 'expected-key', bytes: s.bytes, mime: 'image/jpeg', etag: s.hash }; await s.transport.upload(s.app.scope, input); await s.transport.upload(s.app.scope, input); expect(s.upstream.calls).toHaveLength(1); s.clock.advance(3540_000); await s.transport.upload(s.app.scope, input); expect(s.upstream.calls).toHaveLength(2); await s.transport.upload(s.app.scope, { ...input, purpose: 'cover' }); expect(s.upstream.calls).toHaveLength(3); expect(new URLSearchParams(s.upstream.calls.at(-1)!.body).get('dt')).toBe('2');
  });
  it('does not accept an arbitrary URL or a mismatched object receipt as upload confirmation', async () => {
    const s = await setup(); s.setResponse('https://example.test/picture.jpg', s.hash); await expect(s.transport.upload(s.app.scope, { purpose: 'bill', key: 'expected-key', bytes: s.bytes, mime: 'image/jpeg', etag: s.hash })).rejects.toMatchObject({ code: 'UPLOAD_RECEIPT_INVALID' }); expect(s.providerCalls.filter((call) => call.body)).toHaveLength(1);
  });
});
describe('durable upload intent with transient bytes', () => {
  it('persists that an upload was applied to its business draft so a removed image is not reattached after reload', async () => {
    const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope), decoded = await decodeUpload({ purpose: 'category', mime: 'image/png', dataBase64: tinyPng }); await app.repository(async (repository) => { repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); const config = new ImageConfiguration({ repository, clock }), runtime = new AttachmentRuntime({ clock, configuration: config, transport: { preflight: async () => {}, upload: async (_scope, input) => ({ key: input.key, hash: input.etag }) } }), coordinator = new Coordinator({ repository, clock, client: upstream.client }, new Map([['attachments.upload', createAttachmentMutationHandler(runtime)]])), service = new AttachmentService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope }, coordinator, configuration: config, runtime }); service.saveDraft('category:icon', { requestId: 'icon-apply', purpose: 'category', mime: 'image/png', bytesLength: decoded.bytes.length, sha256: decoded.intent.sha256, fileName: 'icon.png' }); const op = await service.upload({ purpose: 'category', mime: 'image/png', dataBase64: tinyPng, draftKey: 'category:icon' }, { requestId: 'icon-apply' }); const image = service.result(op.id)!; expect(service.markApplied('category:icon', op.id)).toMatchObject({ appliedKey: image.associationValue, operationId: op.id }); expect(service.getDraft('category:icon')?.appliedKey).toBe(image.associationValue);
    });
  });
  it('refuses a delayed upload when its business-form draft has been replaced', async () => {
    const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope); let sends = 0; await app.repository(async (repository) => { repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); const config = new ImageConfiguration({ repository, clock }), runtime = new AttachmentRuntime({ clock, configuration: config, transport: { preflight: async () => {}, upload: async (_scope, input) => { sends++; return { key: input.key, hash: input.etag }; } } }), coordinator = new Coordinator({ repository, clock, client: upstream.client }, new Map([['attachments.upload', createAttachmentMutationHandler(runtime)]])), service = new AttachmentService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope }, coordinator, configuration: config, runtime });
      service.saveDraft('bill:new', { requestId: 'newer-image', purpose: 'category', sha256: 'a'.repeat(64), mime: 'image/png', bytesLength: 1, fileName: 'icon.png' }); await expect(service.upload({ purpose: 'category', mime: 'image/png', dataBase64: tinyPng, draftKey: 'bill:new' }, { requestId: 'older-image' })).rejects.toMatchObject({ code: 'UPLOAD_DRAFT_CHANGED' }); expect(service.getDraft('bill:new')).toMatchObject({ draft: { requestId: 'newer-image' }, operationId: null }); expect(sends).toBe(0);
    });
  });
  it('classifies missing transient bytes as not-sent and prevents a reused key from replacing a queued image purpose', async () => {
    const app = await createTestApp(), clock = new TestClock(); await app.repository((repository) => { const runtime = new AttachmentRuntime({ clock, configuration: new ImageConfiguration({ repository, clock }), transport: { preflight: async () => {}, upload: async () => ({ key: '', hash: '' }) } }), intent = { purpose: 'bill' as const, mime: 'image/jpeg' as const, width: 1, height: 1, bytesLength: 1, sha256: 'a'.repeat(64), etag: 'a'.repeat(28) }; expect(() => runtime.take(app.scope, 'lost-bytes', intent)).toThrowError(expect.objectContaining({ code: 'UPLOAD_BYTES_REQUIRED', certainty: 'not-sent' })); runtime.register(app.scope, 'queued-image', new Uint8Array([1]), intent); expect(() => runtime.register(app.scope, 'queued-image', new Uint8Array([1]), { ...intent, purpose: 'cover' })).toThrowError(expect.objectContaining({ code: 'REQUEST_KEY_REUSED' })); expect(runtime.require(app.scope, 'queued-image', intent)).toEqual(new Uint8Array([1])); });
  });
  it('journals metadata without image bytes and returns a confirmed purpose-specific association value', async () => {
    const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope); let sends = 0;
    await app.repository(async (repository) => {
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); const config = new ImageConfiguration({ repository, clock }), runtime = new AttachmentRuntime({ clock, configuration: config, transport: { preflight: async () => {}, upload: async (_scope, input) => { sends++; return { key: input.key, hash: input.etag }; } } }), coordinator = new Coordinator({ repository, clock, client: upstream.client }, new Map([['attachments.upload', createAttachmentMutationHandler(runtime)]])), service = new AttachmentService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope }, coordinator, configuration: config, runtime });
      const operation = await service.upload({ purpose: 'category', mime: 'image/png', dataBase64: tinyPng }, { requestId: 'image-original' }); expect(operation.state).toBe('succeeded'); const image = service.result(operation.id); expect(image).toMatchObject({ purpose: 'category', mime: 'image/png', width: 1, height: 1 }); expect(image?.key).toMatch(/^cateupload\/_[a-f0-9]{32}\.png$/); expect(image?.associationValue).toBe(`http://img.qianjiapp.com/${image?.key}`); expect(stringifyWire(coordinator.store.get(app.scope, operation.id)!.input)).not.toContain(tinyPng); expect(stringifyWire(coordinator.store.get(app.scope, operation.id)!.prepared!.payload)).not.toContain(tinyPng); expect((await service.upload({ purpose: 'category', mime: 'image/png', dataBase64: tinyPng }, { requestId: 'image-original' })).id).toBe(operation.id); expect(sends).toBe(1);
    });
  });
  it('does not make a key usable after a lost response until the same original object is proved by a readonly probe', async () => {
    const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope); let sends = 0, proved = false;
    await app.repository(async (repository) => {
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); const config = new ImageConfiguration({ repository, clock }), runtime = new AttachmentRuntime({ clock, configuration: config, transport: { preflight: async () => {}, upload: async () => { sends++; throw new Error('lost object response'); } }, probe: async () => proved }), coordinator = new Coordinator({ repository, clock, client: upstream.client }, new Map([['attachments.upload', createAttachmentMutationHandler(runtime)]])), service = new AttachmentService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope }, coordinator, configuration: config, runtime });
      const lost = await service.upload({ purpose: 'category', mime: 'image/png', dataBase64: tinyPng }, { requestId: 'lost-image' }); expect(lost.state).toBe('uncertain'); expect(service.result(lost.id)).toBeNull(); proved = true; expect((await coordinator.reconcileOperation(app.scope, lost.id)).state).toBe('succeeded'); expect(service.result(lost.id)).not.toBeNull(); expect(sends).toBe(1);
    });
  });
});
