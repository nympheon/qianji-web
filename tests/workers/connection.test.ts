import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../support/app';
import { createActorContext } from '../../src/actor/context';
import { CredentialVault } from '../../src/features/connection/vault';
import { passwordDigest } from '../../src/protocol/signer';
import { stringifyWire } from '../../src/shared/wire-json';

const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const input = { account: 'person@example.test', password: 'NON_REAL_PASSWORD' };
const token = 'NON_REAL_QIANJI_TOKEN';
const uid = '1792000000123100000';
function loginReply(id = uid, value = token): Response {
  return new Response(`{"ec":200,"data":{"user":{"id":${id},"name":"测试用户","viptype":-1,"vipend":0,"unknown":"keep private"},"token":"${value}","books":[]}}`);
}
afterEach(() => vi.restoreAllMocks());

describe('personal Qianji connection', () => {
  it('encrypts credentials, binds cipher to scope, and does not expose credentials in its view', async () => {
    const app = await createTestApp();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply());
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      const view = await ctx.connection.login(input);
      expect(view.state).toBe('connected'); expect(view.uid).toBe(uid);
      expect(JSON.stringify(view)).not.toContain(token);
      expect(JSON.stringify(view)).not.toContain(input.password);
      expect(JSON.stringify(view)).not.toContain('unknown');
      const row = repository.sql.exec<{ token_cipher: string; profile_raw: string }>('SELECT token_cipher,profile_raw FROM connection').one();
      expect(row.token_cipher).not.toContain(token);
      expect(row.profile_raw).not.toContain(token);
      expect(row.profile_raw).not.toContain(input.password);
      expect(row.profile_raw).not.toContain(passwordDigest(input.password));
      expect((await ctx.connection.session(ctx.connection.scope()!))?.utoken).toBe(token);
      const form = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body));
      expect(form.get('v')).toBe(input.account); expect(form.get('pwd')).toBe(passwordDigest(input.password));
      expect(form.has('fr')).toBe(false); expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('utoken')).toBe(false);
      const vault = new CredentialVault(secret, 'another-instance');
      await expect(vault.decrypt(row.token_cipher, ctx.connection.scope()!)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED');
      const correctVault = new CredentialVault(secret, repository.sql.exec<{ value: string }>("SELECT value FROM instance_meta WHERE key='instance_id'").one().value);
      await expect(correctVault.decrypt(row.token_cipher, { uid: 'wrong', connectionEpoch: 'wrong' })).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED');
    });
  });

  it('preserves the same UID epoch, device, datasets and operations across relogin and eviction', async () => {
    const app = await createTestApp();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply()).mockImplementationOnce(async () => loginReply(uid, 'NEXT_TOKEN'));
    const first = await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      const view = await ctx.connection.login(input), scope = ctx.connection.scope()!;
      repository.saveDraft(scope, 'draft', { note: '保存' });
      ctx.coordinator.store.create({ action: 'test', input: {}, requestId: 'k', scope }, 'test-digest');
      return { view, device: repository.sql.exec<{ device_id: string }>('SELECT device_id FROM connection').one().device_id };
    });
    await app.restart();
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      const view = await ctx.connection.login({ ...input, account: '13800138000' });
      expect(view.connectionEpoch).toBe(first.view.connectionEpoch);
      expect(repository.sql.exec<{ device_id: string }>('SELECT device_id FROM connection').one().device_id).toBe(first.device);
      expect(repository.readDraft(ctx.connection.scope()!, 'draft')).toEqual({ note: '保存' });
      expect(ctx.coordinator.store.find(ctx.connection.scope()!, 'k')).not.toBeNull();
    });
  });

  it('changes epoch and hides old UID operations on account replacement', async () => {
    const app = await createTestApp();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply()).mockImplementationOnce(async () => loginReply('42', 'OTHER_TOKEN'));
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      const before = await ctx.connection.login(input), oldScope = ctx.connection.scope()!;
      const op = ctx.coordinator.store.create({ action: 'test', input: {}, requestId: 'k', scope: oldScope }, 'test-digest');
      const after = await ctx.connection.login(input);
      expect(after.uid).toBe('42'); expect(after.connectionEpoch).not.toBe(before.connectionEpoch);
      expect(ctx.coordinator.getOperation(ctx.connection.scope()!, op.id)).toBeNull();
      await expect(ctx.connection.session(oldScope)).rejects.toThrow('STALE_CONNECTION');
    });
  });

  it('distinguishes network and HTTP failures from verified session expiration', async () => {
    const app = await createTestApp();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply());
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      await ctx.connection.login(input);
      fetch.mockRejectedValueOnce(new Error('offline'));
      const offline = await ctx.connection.check();
      expect(offline.state).toBe('connected'); expect(offline.problem?.code).toBe('QIANJI_NETWORK_ERROR');
      fetch.mockImplementationOnce(async () => new Response('blocked', { status: 403 }));
      expect((await ctx.connection.check()).state).toBe('connected');
      fetch.mockImplementationOnce(async () => new Response('{"ec":8888,"em":{"code":40005}}'));
      const expired = await ctx.connection.check();
      expect(expired.state).toBe('needs_login'); expect(expired.problem?.code).toBe('QIANJI_SESSION_EXPIRED');
      expect(await ctx.connection.session(ctx.connection.scope()!)).toBeNull();
    });
  });

  it('ignores a late old-token invalidation after the same UID has obtained fresh credentials', async () => {
    const app = await createTestApp();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply());
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      await ctx.connection.login(input);
      let release!: (response: Response) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      fetch.mockImplementationOnce(async () => { entered(); return new Promise((resolve) => { release = resolve; }); });
      const oldCheck = ctx.connection.check(); await started;
      fetch.mockImplementationOnce(async () => loginReply(uid, 'FRESH_TOKEN'));
      await ctx.connection.login(input);
      release(new Response('{"ec":8888,"em":{"code":40005}}'));
      await oldCheck;
      expect(ctx.connection.view().state).toBe('connected');
      expect((await ctx.connection.session(ctx.connection.scope()!))?.utoken).toBe('FRESH_TOKEN');
    });
  });

  it('uses client/init for verification and tests a selected route without changing the configured route', async () => {
    const app = await createTestApp();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply()).mockImplementationOnce(async () => new Response(`{"ec":200,"data":{"userinfo":{"id":"${uid}","name":"更新"},"configs":{},"books":[]}}`));
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      await ctx.connection.login(input);
      expect((await ctx.connection.testRoute('backup')).status).toBe('ok');
      expect(String(fetch.mock.calls[1]?.[0])).toBe('https://qianji.xxoojoke.com/client/init');
      expect(ctx.connection.view().route).toBe('main');
      const params = new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body));
      expect(params.get('uid')).toBe(uid); expect(params.get('v')).toBe('1234'); expect(params.get('newinstall')).toBe('0');
      expect((await ctx.connection.selectRoute('overseas')).route).toBe('overseas');
      await expect(ctx.connection.refresh()).rejects.toThrow('REFRESH_UNVERIFIED');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('requires the encryption Secret before sending a login and never stores a login intent', async () => {
    const app = await createTestApp();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage);
      await expect(ctx.connection.login(input)).rejects.toThrow('CREDENTIAL_KEY_REQUIRED');
      expect(repository.sql.exec('SELECT * FROM operations').toArray()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('disconnects locally even when the remote logout receipt is lost, with no retry on restart', async () => {
    const app = await createTestApp();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => loginReply()).mockRejectedValueOnce(new Error('lost'));
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      await ctx.connection.login(input);
      const view = await ctx.connection.logout();
      expect(view.state).toBe('disconnected'); expect(view.problem?.code).toBe('LOGOUT_REMOTE_UNCONFIRMED');
      expect(repository.sql.exec<{ token_cipher: string | null }>('SELECT token_cipher FROM connection').one().token_cipher).toBeNull();
      expect(stringifyWire(repository.readDraft(ctx.connection.scope()!, 'missing'))).toBe('null');
    });
    await app.restart(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reads the native bookid field into the independent book source and never replays old login books during ledger sync', async () => {
    const app = await createTestApp();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(`{"ec":200,"data":{"user":{"id":"${uid}"},"token":"NON_REAL","books":[{"bookid":10,"name":"原名","visible":1,"config":{"range":"m25"}}]}}`))
      .mockImplementationOnce(async () => new Response('{"ec":200,"data":{"bookid":-1,"pageoffset":0,"pagesign":"","hasmore":0,"count":0,"lasttimes":{"-1":100},"changes":[],"deletes":[],"categories":[]}}'));
    await app.repository(async (repository) => {
      const ctx = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: secret });
      await ctx.connection.login(input); const scope = ctx.connection.scope()!;
      expect(repository.readResources(scope, 'book', { domain: 'books' }).items.map((item) => item.id)).toEqual(['10']);
      ctx.cache.confirmResources(scope, 'books', [{ id: '10', kind: 'book', raw: { bookid: '10', name: '已确认新名', visible: 1 } }]);
      expect((await ctx.sync.start({ domain: 'ledger', mode: 'incremental' })).state).toBe('succeeded');
      expect(repository.readResources(scope, 'book', { domain: 'books' }).items[0]?.raw).toMatchObject({ name: '已确认新名' });
      expect(repository.readResources(scope, 'book', { domain: 'ledger' }).items).toEqual([]);
    });
  });
});
