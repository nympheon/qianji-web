import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/storage/database';
import { projectBill } from '../../src/features/sync/incremental';
import { parseWire } from '../../src/shared/wire-json';
import { page } from '../support/fixtures';
import { createActorContext } from '../../src/actor/context';
import { AppRegistry } from '../../src/app/registry';

export async function seedActions() {
  await runInDurableObject(env.QIANJI_STATE.getByName('personal'), (_actor, state) => {
    const repository = new Repository(state.storage), scope = { uid: crypto.randomUUID(), connectionEpoch: crypto.randomUUID() };
    repository.bindScope(scope);
    repository.sql.exec("UPDATE connection SET state='disconnected',token_cipher=NULL WHERE singleton=1").toArray();
    repository.createDataset(scope, 'ledger', 'dataset');
    repository.applyPage(scope, 'dataset', page({ upserts: [projectBill(parseWire('{"id":1792000000123100001,"bookid":10,"type":0,"time":1768000000,"money":"90","remark":"午餐","extra":{"transfee":"-10"}}'))], complete: true, validatedAt: new Date().toISOString() }));
    repository.switchDataset(scope, 'ledger', 'dataset', null);
  });
}
export const action = (name: string, input: unknown = {}) => exports.default.fetch('https://test/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, input }) });
describe('shared HTTP actions', () => {
  it('keeps unverified writes gated, and saves typed local drafts without contacting Qianji', async () => {
    await seedActions();
    const input = { requestId: 'write-key', bills: [{ bookId: '10', categoryId: '50', type: 0, enteredMoney: '1', timeSec: 1768000000 }] };
    expect(await (await action('ledger.create', input)).json()).toMatchObject({ status: 'unavailable', error: { code: 'WRITE_LIVE_UNVERIFIED' } });
    expect(await (await action('ledger.draft.save', { key: 'new', draft: { kind: 'create', requestId: 'draft-key', fields: { enteredMoney: '1', type: 0 } } })).json()).toMatchObject({ status: 'ready', data: { draft: { requestId: 'draft-key' }, operationId: null } });
    expect(await (await action('ledger.draft.get', { key: 'new' })).json()).toMatchObject({ data: { draft: { fields: { type: 0, enteredMoney: '1' } } } });
  });
  it('offers typed local transfer previews and keeps both transfer write actions unverified', async () => {
    await seedActions();
    await runInDurableObject(env.QIANJI_STATE.getByName('personal'), (_actor, state) => {
      const ctx = createActorContext(state.storage), scope = ctx.connection.scope()!;
      ctx.repository.createDataset(scope, 'books', 'books'); ctx.repository.applyPage(scope, 'books', page({ upserts: [], resources: [{ id: '10', kind: 'book', raw: { bookid: 10, name: 'book' } }], complete: true }), 'books'); ctx.repository.switchDataset(scope, 'books', 'books', null);
      ctx.repository.createDataset(scope, 'assets', 'assets'); ctx.repository.applyPage(scope, 'assets', page({ upserts: [], resources: [{ id: '1', kind: 'asset', raw: { id: 1, name: 'A', currency: 'CNY', money: '1000', type: 0 } }, { id: '2', kind: 'asset', raw: { id: 2, name: 'B', currency: 'CNY', money: '0', type: 2 } }], complete: true }), 'assets'); ctx.repository.switchDataset(scope, 'assets', 'assets', null);
    });
    const input = { mode: 'create', bookId: '10', fromAssetId: '1', targetAssetId: '2', enteredMoney: '103', fee: '3', timeSec: 200 };
    expect(await (await action('ledger.transfer.options')).json()).toMatchObject({ data: { assets: [{ id: '1', money: '1000' }, { id: '2', money: '0' }] } });
    expect(await (await action('ledger.transfer.preview', { kind: 'transfer', input })).json()).toMatchObject({ data: { principal: '100', fromAmount: '103', targetAmount: '100', effects: [{ delta: '-103', confirmation: 'expected' }, { delta: '100', confirmation: 'expected' }], stale: true } });
    for (const name of ['ledger.transfer', 'ledger.repayCard']) expect(await (await action(name, { ...input, requestId: 'stable-key' })).json()).toMatchObject({ status: 'unavailable', error: { code: 'WRITE_LIVE_UNVERIFIED' } });
    expect(await (await action('ledger.refund', { billId: '1792000000123100001', expectedVersion: 'a'.repeat(64), money: '1', timeSec: 200, assetId: null, requestId: 'refund-key' })).json()).toMatchObject({ status: 'unavailable', error: { code: 'WRITE_LIVE_UNVERIFIED' } });
  });
  it('returns exact canonical query values with no-store freshness', async () => {
    await seedActions(); const response = await action('ledger.list');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'ready', data: { items: [{ id: '1792000000123100001', money: '90' }] }, freshness: { complete: true, stale: true } });
    expect(await (await action('ledger.statistics', { currency: 'CNY' })).json()).toMatchObject({ data: { totals: { totalSpend: '90', coupon: '10' } } });
  });
  it('keeps password login separate, rejects unsupported bodies and does not echo unknown input', async () => {
    const response = await action('connection.login', { password: 'DO_NOT_ECHO' });
    expect(await response.text()).not.toContain('DO_NOT_ECHO');
    expect((await exports.default.fetch('https://test/api/actions')).status).toBe(405);
    expect((await exports.default.fetch('https://test/api/actions', { method: 'POST', body: '{}' })).status).toBe(415);
    const invalid = await exports.default.fetch('https://test/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ledger.list', input: {}, password: 'DO_NOT_ECHO' }) });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('DO_NOT_ECHO');
  });
  it('reports the connection URL when there is no bound account and explains unavailable capabilities', async () => {
    await runInDurableObject(env.QIANJI_STATE.getByName('personal'), (_actor, state) => state.storage.sql.exec("UPDATE connection SET uid=NULL,connection_epoch=NULL,state='disconnected',token_cipher=NULL WHERE singleton=1").toArray());
    expect(await (await action('ledger.list')).json()).toMatchObject({ status: 'unavailable', data: { connectionUrl: '/connection' }, error: { code: 'CONNECTION_REQUIRED' } });
    expect(await (await action('capabilities.list')).json()).toMatchObject({ data: expect.arrayContaining([{ action: 'connection.refresh', enabled: false, reason: expect.any(String), kind: 'connection', evidence: 'apk-static' }]) });
  });
  it('keeps a tag-only rebuild independent of already complete ledger reads', async () => {
    await seedActions();
    await runInDurableObject(env.QIANJI_STATE.getByName('personal'), async (_actor, state) => {
      const ctx = createActorContext(state.storage), scope = ctx.connection.scope()!;
      ctx.repository.sql.exec("INSERT INTO rebuild_jobs(id,uid,connection_epoch,domains,child_ids,state,started_ms) VALUES (?,?,?,?,?,'running',?)", crypto.randomUUID(), scope.uid, scope.connectionEpoch, '["tags"]', '[]', Date.now()).toArray();
      expect(await new AppRegistry(ctx).invoke('ledger.list', {})).toMatchObject({ status: 'ready', freshness: { complete: true } });
    });
  });
});
