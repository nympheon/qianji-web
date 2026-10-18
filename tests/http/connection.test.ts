import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
describe('password-only HTTP boundary', () => {
  it('maps the dedicated login endpoint to the same connection service and returns a redacted view', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response('{"ec":200,"data":{"user":{"id":"http-user","name":"测试"},"token":"NON_REAL_HTTP_TOKEN","books":[]}}'));
    const response = await exports.default.fetch('https://test/api/connection/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'person@example.test', password: 'NON_REAL_HTTP_PASSWORD' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).toContain('http-user'); expect(text).not.toContain('NON_REAL_HTTP_TOKEN'); expect(text).not.toContain('NON_REAL_HTTP_PASSWORD');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid input without forwarding it or reflecting password fields', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch');
    const response = await exports.default.fetch('https://test/api/connection/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"account":"invalid","password":"DO_NOT_ECHO","extra":"value"}' });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('DO_NOT_ECHO'); expect(upstream).not.toHaveBeenCalled();
  });
  it('reports network failures without labeling them as incorrect passwords', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    const response = await exports.default.fetch('https://test/api/connection/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"account":"person@example.test","password":"NON_REAL"}' });
    expect(response.status).toBe(502);
    const body = await response.text(); expect(body).toContain('QIANJI_NETWORK_ERROR'); expect(body).not.toContain('密码错误');
  });
});
