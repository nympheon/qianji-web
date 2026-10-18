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
