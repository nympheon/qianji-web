import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { createTransferMutationHandler, transferAmounts, transferEffects } from '../../src/features/ledger/transfer';
import type { TransferAsset, TransferMovement } from '../../src/features/ledger/transfer-contract';
import { projectBill } from '../../src/features/sync/incremental';
import { asBillObject, numericText } from '../../src/shared/bill-wire';
import { parseWire, type WireJson } from '../../src/shared/wire-json';
import { billVersion } from '../../src/features/ledger/write';
import { summarizeBill } from '../../src/features/ledger/model';
import { aggregate, toStatItem } from '../../src/features/ledger/statistics';
import { ResourceCache } from '../../src/storage/cache';
import { calculateBudget } from '../../src/features/budget/calculate';

const assets: TransferAsset[] = [{ id: '10', name: 'A', type: 0, currency: 'CNY', money: '1000', lastPayTimeSec: '0' }, { id: '20', name: 'B', type: 2, currency: 'CNY', money: '-200', lastPayTimeSec: '100' }, { id: '30', name: 'C', type: 0, currency: 'USD', money: '500', lastPayTimeSec: '0' }];
const movement = (fromAssetId = '10', targetAssetId = '20', principal = '100'): TransferMovement => ({ fromAssetId, targetAssetId, principal, fee: '0', currency: null, type: 2, timeSec: 200 });
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope);
  await app.repository((repository) => {
    repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
    for (const domain of ['ledger', 'books', 'assets'] as const) {
      repository.createDataset(app.scope, domain, domain);
      const resources = domain === 'assets' ? assets.map((asset) => ({ id: asset.id, kind: 'asset' as const, raw: { ...asset, lastPayTime: asset.lastPayTimeSec } })) : domain === 'books' ? [{ id: '1', kind: 'book' as const, raw: { bookid: 1, name: 'test' } }] : [];
      repository.applyPage(app.scope, domain, { upserts: [], deletes: [], resources, pageState: null, complete: true, validatedAt: clock.nowIso() }, domain);
      repository.switchDataset(app.scope, domain, domain, null);
    }
    new ResourceCache(repository, clock).publishSnapshot(app.scope, { domain: 'assets', queryKey: 'all', resourceKind: 'asset' }, ['asset']);
  });
  const sent = () => upstream.calls.map((call) => asBillObject(asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)).bills));
  upstream.respond(async () => {
    const body = sent().at(-1)!, changed = (body.changelist as WireJson[]).map((raw) => numericText(asBillObject(raw).id, '')), deleted = (body.dellist as WireJson[]).map((raw) => numericText(raw, ''));
    return new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[],"update_ids":[${changed}],"del_ids":[${deleted}],"conf_ids":[],"has_failed":false}}}}`);
  });
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => {
    const handler = createTransferMutationHandler();
    return fn(new Coordinator({ repository, client: upstream.client, clock }, new Map(['ledger.transfer', 'ledger.repayCard'].map((action) => [action, handler]))));
  });
  const input = { mode: 'create', bookId: '1', fromAssetId: '10', targetAssetId: '20', enteredMoney: '103', fee: '3', timeSec: 200, remark: 'test' };
  return { app, clock, upstream, run, input, sent };
}
describe('native transfer/card semantics', () => {
  it('separates103/fee3 into principal100 and debit103/credit100, and100/coupon-10 into90/100', () => {
    expect(transferAmounts('103', '3')).toMatchObject({ principal: '100', fromAmount: '103', targetAmount: '100' });
    expect(transferAmounts('100', '-10')).toMatchObject({ principal: '90', fromAmount: '90', targetAmount: '100' });
    expect(() => transferAmounts('1', '2')).toThrow('TRANSFER_AMOUNT_INVALID');
  });
  it('uses historical targetValue and native same-currency correction', () => {
    const currency = { srcSymbol: 'USD', srcValue: '103', targetSymbol: 'CNY', targetValue: '720', baseSymbol: 'CNY', baseValue: '741.6' };
    expect(transferAmounts('103', '3', currency)).toMatchObject({ principal: '100', targetAmount: '720' });
    expect(transferAmounts('103', '3', { ...currency, targetSymbol: 'USD', targetValue: '999' })).toMatchObject({ targetAmount: '100', currency: { targetValue: '100' } });
  });
  it('merges rollback/new changes once per asset when changing A→B to B→A or A→C', () => {
    expect(transferEffects(movement('20', '10'), movement(), assets).map((effect) => [effect.assetId, effect.delta])).toEqual([['10', '200'], ['20', '-200']]);
    expect(transferEffects(movement('10', '30', '120'), movement(), assets).map((effect) => [effect.assetId, effect.delta])).toEqual([['10', '-20'], ['20', '-100'], ['30', '120']]);
  });
  it('advances lastPayTime only on a new later card payment; editing/deleting never rewinds it', () => {
    const payment = { ...movement(), type: 3 as const, timeSec: 200 };
    expect(transferEffects(payment, null, assets).find((item) => item.assetId === '20')?.expectedLastPayTimeSec).toBe('200');
    expect(transferEffects({ ...payment, timeSec: 50 }, null, assets).every((item) => item.expectedLastPayTimeSec === undefined)).toBe(true);
    expect(transferEffects(payment, payment, assets).every((item) => item.expectedLastPayTimeSec === undefined)).toBe(true);
    expect(transferEffects(null, payment, assets).every((item) => item.expectedLastPayTimeSec === undefined)).toBe(true);
  });
  it('sends one real type2 record and exposes predicted effects without overwriting confirmed asset balances', async () => {
    const s = await setup();
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.transfer', input: s.input, requestId: 'transfer', scope: s.app.scope }));
    expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1);
    const raw = asBillObject((s.sent()[0]!.changelist as WireJson[])[0]!);
    expect(numericText(raw.type, '')).toBe('2'); expect(numericText(raw.money, '')).toBe('100'); expect(numericText(raw.cateid, '')).toBe('0');
    expect(result.items[0]?.assetEffects?.map((item) => [item.assetId, item.delta, item.confirmation])).toEqual([['10', '-103', 'expected'], ['20', '100', 'expected']]);
    await s.app.repository((repo) => {
      expect(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money).toBe('1000');
      expect(new ResourceCache(repo, s.clock).read(s.app.scope, { domain: 'assets', queryKey: 'all', resourceKind: 'asset' }).stale).toBe(true);
    });
    const bill = summarizeBill(projectBill(raw)), detail = { ...bill, refunds: [], reimbursements: [], sources: [], missingRelatedIds: [], incompleteReasons: [], freshness: { revision: '1', complete: true, stale: false, syncedAt: null } }, summary = aggregate([toStatItem(detail, 'statistics', 'CNY')]);
    expect(summary.totalSpend).toBe('3'); expect(summary.transfer).toBe('100');
    expect(calculateBudget({ bills: [detail], budgets: [], categories: [], currency: 'CNY', range: { startSec: 0, endSec: 300, zone: 'Asia/Shanghai' }, nowSec: 200 }).used).toBe('3');
  });
  it('rejects missing/same/debt assets before send and does not silently convert different currencies', async () => {
    const s = await setup();
    for (const [patch, code] of [[{ targetAssetId: '10' }, 'TRANSFER_SAME_ASSET'], [{ targetAssetId: '99' }, 'ASSET_NOT_LOADED'], [{ targetAssetId: '30' }, 'TRANSFER_CURRENCY_REQUIRED']] as const) {
      const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.transfer', input: { ...s.input, ...patch }, requestId: crypto.randomUUID(), scope: s.app.scope }));
      expect(result.error?.code).toBe(code);
    }
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '20', kind: 'asset', raw: { id: 20, type: 5, money: 0, name: 'debt' } }], pageState: null }, 'assets'));
    const debt = await s.run((coordinator) => coordinator.submit({ action: 'ledger.transfer', input: s.input, requestId: 'debt', scope: s.app.scope }));
    expect(debt.error?.code).toBe('DEBT_ASSET_UNSUPPORTED'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('persists cross-currency card payment as one type3 bill with historical target amounts and a forward-only local date expectation', async () => {
    const s = await setup();
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.repayCard', input: { ...s.input, fromAssetId: '30', currency: { srcSymbol: 'USD', srcValue: '103', targetSymbol: 'CNY', targetValue: '720', baseSymbol: 'CNY', baseValue: '741.6' } }, requestId: 'card', scope: s.app.scope }));
    expect(result.state).toBe('succeeded');
    const raw = asBillObject((s.sent()[0]!.changelist as WireJson[])[0]!);
    expect(numericText(raw.type, '')).toBe('3');
    expect(numericText(asBillObject(asBillObject(raw.extra).curr).tv, '')).toBe('720');
    expect(result.items[0]?.assetEffects?.find((effect) => effect.assetId === '20')).toMatchObject({ delta: '720', expectedLastPayTimeSec: '200' });
    expect(result.items[0]?.assetEffects?.find((effect) => effect.assetId === '30')).toMatchObject({ delta: '-103', currency: 'USD' });
    await s.app.repository((repo) => expect(numericText(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['20'] }).items[0]!.raw).lastPayTime, '')).toBe('100'));
  });
  it('edits and deletes the same transfer with long ID/unknown extra intact and merged impacts', async () => {
    const s = await setup(), original = projectBill(parseWire('{"id":1792000000123100001,"bookid":1,"type":2,"time":100,"money":100,"fromid":10,"targetid":20,"extra":{"transfee":0,"future":9223372036854775801}}'));
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [original], deletes: [], resources: [], pageState: null }));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.transfer', input: { mode: 'edit', id: original.id, expectedVersion: billVersion(original.raw), changes: { fromAssetId: '20', targetAssetId: '10' } }, requestId: 'edit', scope: s.app.scope }));
    expect(result.state).toBe('succeeded'); expect(result.items[0]?.assetEffects?.map((effect) => effect.delta)).toEqual(['200', '-200']);
    const raw = asBillObject((s.sent()[0]!.changelist as WireJson[])[0]!); expect(numericText(asBillObject(raw.extra).future, '')).toBe('9223372036854775801');
    const current = await s.app.repository((repo) => repo.readBill(s.app.scope, original.id)!);
    const removed = await s.run((coordinator) => coordinator.submit({ action: 'ledger.transfer', input: { mode: 'delete', id: original.id, expectedVersion: billVersion(current.raw) }, requestId: 'delete', scope: s.app.scope }));
    expect(removed.state).toBe('succeeded'); expect(s.sent()[1]!.dellist?.toString()).toBe(original.id);
  });
  it('preserves a historical fee and both amounts when the only edit is a remark', async () => {
    const s = await setup(), original = projectBill(parseWire('{"id":1792000000123100010,"bookid":1,"type":2,"time":100,"money":100,"fromid":30,"targetid":20,"extra":{"transfee":3,"curr":{"ss":"USD","sv":103,"ts":"CNY","tv":720,"bs":"CNY","bv":741.6}}}'));
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [original], deletes: [], resources: [], pageState: null }));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.transfer', input: { mode: 'edit', id: original.id, expectedVersion: billVersion(original.raw), changes: { remark: 'only remark' } }, requestId: 'remark-only', scope: s.app.scope }));
    expect(result.state).toBe('succeeded');
    const raw = asBillObject((s.sent()[0]!.changelist as WireJson[])[0]!);
    expect(numericText(raw.money, '')).toBe('100'); expect(numericText(asBillObject(raw.extra).transfee, '')).toBe('3');
    expect(numericText(asBillObject(asBillObject(raw.extra).curr).tv, '')).toBe('720');
    expect(result.items[0]?.assetEffects?.every((effect) => effect.delta === '0')).toBe(true);
  });
});
