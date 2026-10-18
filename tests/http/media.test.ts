import { afterEach, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { Repository } from '../../src/storage/database';
import { handleImageHttp } from '../../src/worker/images';
afterEach(() => vi.restoreAllMocks());
it('bounds MCP image JSON before the SDK parses base64', async () => {
  const response = await exports.default.fetch('https://test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array(12 * 1024 * 1024 + 1) }); expect(response.status).toBe(413);
  const within = await exports.default.fetch('https://test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'attachments.upload', arguments: { requestId: 'bounded-image', purpose: 'bill', mime: 'image/jpeg', dataBase64: 'A'.repeat(5 * 1024 * 1024) } } }) }); expect(within.status).not.toBe(413);
});
it('accepts a bounded multipart image through the same shared write gate and rejects unsupported forms', async () => {
  const body = new FormData(); body.set('purpose', 'category'); body.set('requestId', 'multipart-image'); body.set('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'icon.png');
  const response = await exports.default.fetch('https://test/api/uploads', { method: 'POST', body }); expect(await response.json()).toMatchObject({ status: 'unavailable', error: { code: 'WRITE_LIVE_UNVERIFIED' } }); expect((await exports.default.fetch('https://test/api/uploads')).status).toBe(405); expect((await exports.default.fetch('https://test/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(415);
});
it('bounds the upload body before parsing it as multipart', async () => {
  const response = await exports.default.fetch('https://test/api/uploads', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: new Uint8Array(8 * 1024 * 1024 + 65537) }); expect(response.status).toBe(413);
});
it('serves native HTTP media through same-origin HTTPS without forwarding user credentials or fetching arbitrary origins', async () => {
  await runInDurableObject(env.QIANJI_STATE.getByName('personal'), (_actor, state) => new Repository(state.storage).bindScope({ uid: 'media-test', connectionEpoch: 'media-test' }));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
  const response = await handleImageHttp(new Request('https://test/api/images?reference=http%3A%2F%2Fimg.qianjiapp.com%2Fcateupload%2F_test.png&purpose=category', { headers: { authorization: 'must-not-forward', cookie: 'must-not-forward' } }), env); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png'); expect(fetch.mock.calls[0]![0]).toBe('http://img.qianjiapp.com/cateupload/_test.png'); const headers = new Headers(fetch.mock.calls[0]![1]?.headers); expect(headers.has('authorization')).toBe(false); expect(headers.has('cookie')).toBe(false); expect(fetch.mock.calls[0]![1]?.redirect).toBe('manual');
  fetch.mockClear(); expect((await handleImageHttp(new Request('https://test/api/images?reference=http%3A%2F%2Fexample.test%2Fpicture.png'), env)).status).toBe(502); expect(fetch).not.toHaveBeenCalled();
});
