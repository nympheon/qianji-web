import { exports, env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createTestApp } from '../support/app';
import { createActorContext } from '../../src/actor/context';
import { AppRegistry } from '../../src/app/registry';
import { parseWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import { page } from '../support/fixtures';
import { Repository } from '../../src/storage/database';

interface RpcReply { result?: { tools?: { name: string; inputSchema: object; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }[]; structuredContent?: unknown; protocolVersion?: string; _meta?: object }; error?: { code: number } }
async function rpc(method: string, params: object = {}, modern = false) {
  const response = await exports.default.fetch('https://test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(modern ? { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...('name' in params && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...(modern ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } : {}) } }) });
  const text = await response.text(), data = response.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5).trim() : text;
  return { response, body: JSON.parse(data) as RpcReply };
}
afterEach(() => vi.restoreAllMocks());
describe('stateless MCP transport', () => {
  it('serves legacy initialize and modern discovery without issuing MCP session IDs', async () => {
    const legacy = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(legacy.body.result?.protocolVersion).toBe('2025-11-25'); expect(legacy.response.headers.has('mcp-session-id')).toBe(false);
    const modern = await rpc('server/discover', {}, true);
    expect(modern.body.error).toBeUndefined(); expect(modern.body.result).toBeDefined(); expect(modern.response.headers.has('mcp-session-id')).toBe(false);
  });
  it('discovers only explicit business tools with safe schemas and correct read annotations', async () => {
    for (const modern of [false, true]) {
      const { response, body } = await rpc('tools/list', {}, modern);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(body.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['ledger.list', 'ledger.statistics', 'sync.start', 'capabilities.list']));
      expect(body.result?.tools?.find((tool) => tool.name === 'ledger.list')?.annotations?.readOnlyHint).toBe(true);
      expect(body.result?.tools?.find((tool) => tool.name === 'ledger.create')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
      expect(body.result?.tools?.find((tool) => tool.name === 'ledger.delete')?.annotations?.destructiveHint).toBe(true);
      expect(JSON.stringify(body.result?.tools)).not.toMatch(/password|executeSql|rawRequest|connection.login/);
    }
  });
  it('returns the same AppReply through HTTP and MCP and keeps business errors structured', async () => {
    await runInDurableObject(env.QIANJI_STATE.getByName('personal'), (_actor, state) => {
      const repo = new Repository(state.storage), scope = { uid: crypto.randomUUID(), connectionEpoch: crypto.randomUUID() };
      repo.bindScope(scope); repo.sql.exec("UPDATE connection SET state='disconnected' WHERE singleton=1").toArray();
      repo.createDataset(scope, 'ledger', 'dataset'); repo.applyPage(scope, 'dataset', page({ upserts: [projectBill(parseWire('{"id":1792000000123100001,"bookid":10,"type":0,"time":1768000000,"money":"90"}'))], complete: true, validatedAt: '2026-01-10T00:00:00Z' })); repo.switchDataset(scope, 'ledger', 'dataset', null);
    });
    const input = { amount: { min: '89' } };
    const http = await exports.default.fetch('https://test/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ledger.list', input }) });
    for (const modern of [false, true]) expect((await rpc('tools/call', { name: 'ledger.list', arguments: input }, modern)).body.result?.structuredContent).toEqual(await http.clone().json());
    expect((await rpc('tools/call', { name: 'connection.refresh', arguments: {} })).body.result?.structuredContent).toMatchObject({ status: 'unavailable', error: { code: 'REFRESH_UNVERIFIED' } });
  });
  it('returns confirmed cached bills and one durable running job while the upstream read is held', async () => {
    const app = await createTestApp(), background: Promise<unknown>[] = [];
    let finish!: () => void;
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response('{"ec":200,"data":{"user":{"id":"slow-user"},"token":"NON_REAL","books":[]}}')).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(new Response('{"ec":200,"data":{"bookid":-1,"pageoffset":0,"pagesign":"","hasmore":0,"count":0,"lasttimes":{"-1":100},"changes":[],"deletes":[],"categories":[]}}')); }));
    await app.repository(async (repo) => {
      const ctx = createActorContext(repo.storage, { QIANJI_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, { waitUntil: (promise) => { background.push(promise); } });
      await ctx.connection.login({ account: 'person@example.test', password: 'NON_REAL' }); const scope = ctx.connection.scope()!;
      repo.createDataset(scope, 'ledger', 'dataset'); repo.applyPage(scope, 'dataset', page({ upserts: [projectBill(parseWire('{"id":1,"bookid":10,"type":0,"time":1768000000,"money":"90"}'))], complete: true, validatedAt: new Date(Date.now() - 61_000).toISOString() })); repo.switchDataset(scope, 'ledger', 'dataset', parseWire('{"-1":100}'));
      const registry = new AppRegistry(ctx), first = await registry.invoke('ledger.list', {}), second = await registry.invoke('ledger.list', {});
      expect(first).toMatchObject({ status: 'running', jobId: expect.any(String), data: { items: [{ money: '90' }] } }); expect(second.jobId).toBe(first.jobId);
      expect(await registry.invoke('ledger.statistics', { currency: 'CNY' })).toMatchObject({ status: 'running', jobId: first.jobId, data: null });
      expect(await registry.invoke('sync.status', { jobId: first.jobId })).toMatchObject({ status: 'running', jobId: first.jobId }); expect(upstream).toHaveBeenCalledTimes(2);
      finish(); await Promise.all(background);
      expect(await registry.invoke('ledger.list', {})).toMatchObject({ status: 'ready', freshness: { complete: true, stale: false } });
    });
  });
});
