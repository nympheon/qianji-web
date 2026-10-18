import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../fixtures/apk-454/signing-vectors.json';
import { createReqidv2, createTok, encodeReqid, passwordDigest, signRequest } from '../../src/protocol/signer';
import { CLIENT_PROFILE } from '../../src/protocol/profile';
import { QianjiClient } from '../../src/protocol/client';
import { stringifyWire } from '../../src/shared/wire-json';

const scope = { uid: '1792000000123100000', connectionEpoch: 'test-epoch' };
const session = { scope, utoken: 'fixture-token' };
const clock = { nowMs: () => 1792000000123, nowIso: () => '2026-10-14T16:26:40.123Z' };
const context = { clock, deviceId: () => '0123456789abcdef0123456789abcdef', route: () => 'main' as const, session: async () => session };

afterEach(() => vi.useRealTimers());

describe('APK native signing contract', () => {
  it.each(vectors.vectors)('matches native $ctrl/$act at version $versionCode', vector => {
    const reqid = createReqidv2({ packageName: vector.package, versionCode: vector.versionCode, nowMs: vector.nowMs, ctrl: vector.ctrl, act: vector.act });
    expect(reqid).toBe(vector.reqidv2);
    expect(encodeReqid(reqid)).toBe(vector.encodedReqid);
    expect(createTok(reqid, vector.ctrl, vector.act)).toBe(vector.tok);
  });

  it('uses the inspected release profile and constructor-specific identity', async () => {
    const signed = await signRequest({ op: 'account.refreshtoken', params: { uid: scope.uid }, profile: CLIENT_PROFILE,
      nowMs: clock.nowMs(), deviceId: context.deviceId(), route: 'main', session });
    const headers = new Headers(signed.headers);
    expect(signed.url).toBe('https://api.qianjiapp.com/account/refreshtoken');
    expect(headers.get('mk')).toBe('guanwang');
    expect(headers.get('vs')).toBe('1234');
    expect(headers.get('vsn')).toBe('4.5.4');
    expect(headers.get('htoken')).toBeNull();
    expect(headers.get('utoken')).toBe('fixture-token');
    expect(new URLSearchParams(signed.body).get('fr')).toBe(scope.uid);

    const sync = await signRequest({ op: 'syncv2.pull', params: { bookid: '-1' }, profile: CLIENT_PROFILE,
      nowMs: clock.nowMs(), deviceId: context.deviceId(), route: 'backup', session });
    expect(new Headers(sync.headers).get('htoken')).toBe('1');
    expect(sync.url).toBe('https://qianji.xxoojoke.com/syncv2/pull');
  });

  it('does not attach an old account to an initial password login', async () => {
    const signed = await signRequest({ op: 'account.login', params: { v: 'fixture@example.test', pwd: passwordDigest('password'), omitted: null },
      profile: CLIENT_PROFILE, nowMs: clock.nowMs(), deviceId: context.deviceId(), route: 'main' });
    expect(new Headers(signed.headers).get('utoken')).toBeNull();
    expect(new URLSearchParams(signed.body).get('fr')).toBeNull();
    expect(new URLSearchParams(signed.body).get('pwd')).toBe('5f4dcc3b5aa765d61d8327deb882cf99');
    expect(new URLSearchParams(signed.body).has('omitted')).toBe(false);
  });
});

describe('fixed upstream transport', () => {
  it('preserves lossless response data and sends one scoped request', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = new QianjiClient({ ...context, fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response('{"ec":200,"data":{"id":1792000000123100000}}');
    } });
    const reply = await client.request('syncv2.pull', { bookid: '-1', lasttimes: { '1792000000123100000': '0' } }, scope);
    expect(stringifyWire(reply.data)).toBe('{"id":1792000000123100000}');
    expect(requests).toHaveLength(1);
    expect(new URLSearchParams(requests[0]!.init.body as string).get('lasttimes')).toBe('{"1792000000123100000":"0"}');
    expect(requests[0]!.init.redirect).toBe('error');
  });

  it('times out after 20 seconds without retrying the upstream operation', async () => {
    vi.useFakeTimers();
    let sends = 0;
    const client = new QianjiClient({ ...context, fetch: async (_url, init) => {
      sends++;
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    } });
    const result = client.request('syncv2.pull', { bookid: '-1' }, scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ code: 'QIANJI_TIMEOUT', certainty: 'unknown' });
    expect(sends).toBe(1);
  });

  it('keeps structured session errors distinct from HTTP failures', async () => {
    const expired = new QianjiClient({ ...context, fetch: async () => new Response('{"ec":8888,"em":"{\\"code\\":40005,\\"msg\\":\\"expired\\"}"}') });
    await expect(expired.request('client.init', {}, scope)).rejects.toMatchObject({ code: 'QIANJI_SESSION_EXPIRED', upstreamCode: '8888', upstreamSubcode: '40005' });
    const forbidden = new QianjiClient({ ...context, fetch: async () => new Response('blocked', { status: 403 }) });
    await expect(forbidden.request('client.init', {}, scope)).rejects.toMatchObject({ code: 'QIANJI_HTTP_ERROR', httpStatus: 403, certainty: 'unknown' });
  });

  it('also applies the timeout while reading a response body', async () => {
    vi.useFakeTimers();
    const client = new QianjiClient({ ...context, fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      },
    })) });
    const result = client.request('client.init', {}, scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ code: 'QIANJI_TIMEOUT', certainty: 'unknown' });
  });

  it('rejects malformed successful replies without echoing their contents', async () => {
    const client = new QianjiClient({ ...context, fetch: async () => new Response('{"token":"private-fixture') });
    const error = await client.request('client.init', {}, scope).catch(error => error);
    expect(error).toMatchObject({ code: 'QIANJI_RESPONSE_INVALID', certainty: 'unknown' });
    expect(error.message).not.toContain('private-fixture');
  });

  it('rejects missing or mismatched identity before sending anything', async () => {
    let sends = 0;
    const client = new QianjiClient({ ...context, fetch: async () => { sends++; return new Response('{}'); } });
    await expect(client.request('syncv2.pull', {}, null)).rejects.toMatchObject({ code: 'QIANJI_NOT_CONNECTED', certainty: 'not-sent' });
    await expect(client.request('syncv2.pull', {}, { ...scope, uid: 'another-user' })).rejects.toMatchObject({ code: 'QIANJI_SCOPE_MISMATCH', certainty: 'not-sent' });
    expect(sends).toBe(0);
  });
});
