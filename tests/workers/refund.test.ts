import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { createRefundMutationHandler, nativeRefundCount, nativeRefundTotal } from '../../src/features/ledger/refund';
import { asBillObject, billExtra, numericText } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import { billVersion, createLedgerMutationHandler } from '../../src/features/ledger/write';
import { createLedgerDeletionHandler } from '../../src/features/ledger/deletion';
import { createActorContext } from '../../src/actor/context';
import { LedgerService } from '../../src/features/ledger/service';
import { FreshnessService } from '../../src/features/sync/freshness';
import { addMoney } from '../../src/shared/numbers';
import { calculateBudget } from '../../src/features/budget/calculate';

const sourceId = '1792000000123100001', childId = '1792000000123100010';
const source = () => parseWire(`{"id":${sourceId},"bookid":1,"type":0,"money":100,"time":1768000000,"userid":"user-A","cateid":2,"extra":{"unknown":true}}`);
function child(money = '30', assetId = '-1') { return parseWire(`{"id":${childId},"bookid":1,"type":20,"money":${money},"time":1770000000,"userid":"user-A","cateid":2,"assetid":${assetId},"extra":{"refundsid":${sourceId}}}`); }
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope), original = projectBill(source());
  await app.repository((repo) => {
    repo.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
    for (const domain of ['ledger', 'books', 'assets'] as const) {
      repo.createDataset(app.scope, domain, domain);
      repo.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? [original] : [], deletes: [], resources: domain === 'ledger' ? [{ id: '2', kind: 'category', raw: { id: 2, bookid: 1, name: 'test' } }] : domain === 'books' ? [{ id: '1', kind: 'book', raw: { bookid: 1, name: 'test' } }] : [10, 20].map((id) => ({ id: String(id), kind: 'asset' as const, raw: { id, type: 0, name: String(id), currency: 'CNY', money: '1000' } })), pageState: null, complete: true, validatedAt: clock.nowIso() }, domain);
      repo.switchDataset(app.scope, domain, domain, null);
    }
  });
  const updated = asBillObject(source()); updated.extra = { unknown: true, rfds: { [childId]: 30 } };
  upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: [updated, child()] })));
  const handler = createRefundMutationHandler();
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => fn(new Coordinator({ repository, client: upstream.client, clock }, new Map([['ledger.refund', handler], ['ledger.edit', createLedgerMutationHandler()], ['ledger.delete', createLedgerDeletionHandler()]]))));
  const input = { billId: sourceId, expectedVersion: billVersion(original.raw), money: '30', timeSec: 1770000000, assetId: null };
  const command = (overrides = {}, requestId: string = crypto.randomUUID()) => ({ action: 'ledger.refund', input: { ...input, ...overrides }, requestId, scope: app.scope });
  return { app, clock, upstream, original, run, input, updated, command };
}
describe('dedicated native refund', () => {
  it('preserves the distinct native count/total legacy rules and new-field priority', () => {
    const raw = { extra: parseWire('{"rfds":{},"refundid":11,"refundsid":-1,"refundv":10}') };
    expect(nativeRefundCount(raw)).toBe(0); expect(nativeRefundTotal(raw)).toBe('10');
    raw.extra = parseWire('{"refundid":11,"refundsid":12,"refundv":10}'); expect(nativeRefundCount(raw)).toBe(1);
    raw.extra = parseWire('{"rfds":{"22":3},"refundid":11,"refundsid":12,"refundv":10}'); expect(nativeRefundCount(raw)).toBe(1); expect(nativeRefundTotal(raw)).toBe('3');
  });
  it('saves the entire authoritative source/child group atomically with long-ID mapping and stable-key dedupe', async () => {
    const s = await setup(), cmd = s.command();
    await s.run(async (coordinator) => {
      const result = await coordinator.submit(cmd); expect(result.state).toBe('succeeded');
      expect(result.affectedIds).toEqual(expect.arrayContaining([sourceId, childId])); expect(Object.values(result.idMap)).toContain(childId);
      expect((await coordinator.submit(cmd)).id).toBe(result.id); expect(s.upstream.calls).toHaveLength(1);
    });
    expect(s.upstream.calls[0]!.url).toContain('/bill/refund2');
    const params = new URLSearchParams(s.upstream.calls[0]!.body); expect(params.get('did')).toBe(sourceId);
    expect(numericText(asBillObject(parseWire(params.get('v')!)).money, '')).toBe('30');
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, childId)?.type).toBe(20); expect(repo.readBill(s.app.scope, sourceId)?.relations[0]?.targetId).toBe(childId); expect(billExtra(asBillObject(repo.readBill(s.app.scope, sourceId)!.raw)).unknown).toBe(true); });
  });
  it('allows the24th/25th boundary correctly, refuses another user, and does not impose an invented remaining-money cap', async () => {
    const s = await setup(), raw = asBillObject(source());
    raw.extra = { rfds: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(1000 + i), 1])) };
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw)], deletes: [], resources: [], pageState: null }));
    const blocked = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(raw) }))); expect(blocked.error?.code).toBe('REFUND_COUNT_LIMIT'); expect(s.upstream.calls).toHaveLength(0);
    delete asBillObject(asBillObject(raw.extra).rfds)['1024'];
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw)], deletes: [], resources: [], pageState: null }));
    const over = asBillObject(child('200')); s.updated.extra = { rfds: { [childId]: 200 } };
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: [s.updated, over] })));
    expect((await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(raw), money: '200' })))).state).toBe('succeeded');
    raw.userid = 'other'; await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw)], deletes: [], resources: [], pageState: null }));
    const other = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(raw) }))); expect(other.error?.code).toBe('REFUND_OTHER_USER');
  });
  it('uses numeric existing billid and a nested currency JSON string, with expected old/new asset deltas', async () => {
    const s = await setup(), previous = child('20', '10');
    s.updated.extra = { rfds: { [childId]: 20 } };
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(previous)], deletes: [], resources: [], pageState: null }));
    const next = asBillObject(child('30', '20')); next.extra = { refundsid: parseWire(sourceId), curr: { ss: 'CNY', sv: 30, ts: 'CNY', tv: 30, bs: 'CNY', bv: 30 } };
    const updated = { ...s.updated, extra: { rfds: { [childId]: 30 } } };
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: [updated, next] })));
    const result = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(s.updated), refundBillId: childId, refundExpectedVersion: billVersion(previous), assetId: '20', currency: { srcSymbol: 'CNY', srcValue: '30', targetSymbol: 'CNY', targetValue: '30', baseSymbol: 'CNY', baseValue: '30' } })));
    expect(result.state).toBe('succeeded');
    const wire = asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)); expect(numericText(wire.billid, '')).toBe(childId); expect(typeof wire.currency).toBe('string');
    expect(numericText(asBillObject(parseWire(String(wire.currency))).srcFee, '')).toBe('0');
    expect(result.items[0]?.assetEffects?.map((effect) => [effect.assetId, effect.delta])).toEqual([['10', '-20'], ['20', '30']]);
  });
  it('keeps malformed groups and lost replies unknown without replacing just the parent or creating ordinary income', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: [s.updated] })));
    const cmd = s.command(), result = await s.run((coordinator) => coordinator.submit(cmd)); expect(result.state).toBe('uncertain');
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, childId)).toBeNull(); expect(repo.readBill(s.app.scope, sourceId)?.relations).toEqual([]); });
    await s.app.restart(); await s.run(async (coordinator) => { await coordinator.recover(); await coordinator.submit(cmd); }); expect(s.upstream.calls).toHaveLength(1);
  });
  it('does not silently claim that an empty remark clears an existing refund', async () => {
    const s = await setup(), previous = asBillObject(child()); previous.remark = 'keep';
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(previous)], deletes: [], resources: [], pageState: null }));
    const result = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(s.updated), refundBillId: childId, refundExpectedVersion: billVersion(previous), remark: '' })));
    expect(result.error?.code).toBe('REFUND_CLEAR_UNVERIFIED'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('preserves existing images/tags instead of silently interpreting empty lists as clearing', async () => {
    const s = await setup(), previous = asBillObject(child()); previous.images = ['existing-key']; previous.extra = { ...billExtra(previous), tags: ['existing-tag'] };
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(previous)], deletes: [], resources: [], pageState: null }));
    for (const clearing of [{ images: [] }, { tagIds: [] }]) {
      const result = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(s.updated), refundBillId: childId, refundExpectedVersion: billVersion(previous), ...clearing })));
      expect(result.error?.code).toBe('REFUND_CLEAR_UNVERIFIED');
    }
    expect(s.upstream.calls).toHaveLength(0);
  });
  it('permits a source remark edit while preserving refund links, but locks its native type', async () => {
    const s = await setup();
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(child())], deletes: [], resources: [], pageState: null }));
    const command = (changes: Record<string, string | number>) => ({ action: 'ledger.edit', input: { bills: [{ id: sourceId, expectedVersion: billVersion(s.updated), changes }] }, requestId: crypto.randomUUID(), scope: s.app.scope });
    const locked = await s.run((coordinator) => coordinator.submit(command({ type: 1 })));
    expect(locked.error?.code).toBe('REFUND_SOURCE_TYPE_LOCKED');
    s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[],"update_ids":[${sourceId}],"del_ids":[],"conf_ids":[],"has_failed":false}}}}`));
    const edited = await s.run((coordinator) => coordinator.submit(command({ remark: 'source remark' }))); expect(edited.state).toBe('succeeded');
    await s.app.repository((repo) => expect(repo.readBill(s.app.scope, sourceId)?.relations[0]?.targetId).toBe(childId));
  });
  it('invalidates cached source-month/category totals after a cross-month refund group receipt', async () => {
    const s = await setup();
    await s.app.repository(async (repo) => {
      const ctx = createActorContext(repo.storage), ledger = new LedgerService({ repository: repo, connection: ctx.connection, clock: s.clock, freshness: new FreshnessService({ repository: repo, clock: s.clock, sync: ctx.sync }) });
      const input = { currency: 'CNY', filter: { bookIds: ['1'], date: { kind: 'month' as const, year: 2026, month: 1 } }, dimensions: ['category' as const] };
      expect((await ledger.statistics(input)).totals.totalSpend).toBe('100');
      const coordinator = new Coordinator({ repository: repo, client: s.upstream.client, clock: s.clock }, new Map([['ledger.refund', createRefundMutationHandler()]]));
      expect((await coordinator.submit(s.command())).state).toBe('succeeded');
      const after = await ledger.statistics(input); expect(after.totals.totalSpend).toBe('70'); expect(after.groups[0]?.items[0]?.totals.totalSpend).toBe('70');
      expect(calculateBudget({ bills: [await ledger.detail(sourceId)], budgets: [], categories: [], currency: 'CNY', range: after.range!, nowSec: Math.floor(s.clock.nowMs() / 1000) }).used).toBe('70');
    });
  });
  it('expands parent deletion to real refund IDs and tracks each acknowledgement without invented parent updates', async () => {
    const s = await setup();
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(child())], deletes: [], resources: [], pageState: null }));
    s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[],"update_ids":[],"del_ids":[${sourceId},${childId}],"conf_ids":[],"has_failed":false}}}}`));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.delete', input: { bills: [{ id: sourceId, expectedVersion: billVersion(s.updated) }] }, requestId: 'delete-parent', scope: s.app.scope }));
    expect(result.state).toBe('succeeded'); expect(result.items.map((item) => item.id)).toEqual([sourceId, childId]);
    const wire = asBillObject(asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)).bills);
    expect(wire.changelist).toEqual([]); expect((wire.dellist as unknown[]).map(String)).toEqual([sourceId, childId]);
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, sourceId)).toBeNull(); expect(repo.readBill(s.app.scope, childId)).toBeNull(); });
  });
  it('confirms a child delete separately from its read-only parent relationship verification', async () => {
    const s = await setup(), refund = child();
    await s.app.repository(async (repo) => {
      repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(refund)], deletes: [], resources: [], pageState: null });
      s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[],"update_ids":[],"del_ids":[${childId}],"conf_ids":[],"has_failed":false}}}}`));
      const handler = createLedgerDeletionHandler({ reconcileSource: async () => {
        repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(source())], deletes: [], resources: [], pageState: null, validatedAt: s.clock.nowIso(), complete: true }); return true;
      } });
      const coordinator = new Coordinator({ repository: repo, client: s.upstream.client, clock: s.clock }, new Map([['ledger.delete', handler]]));
      const result = await coordinator.submit({ action: 'ledger.delete', input: { bills: [{ id: childId, expectedVersion: billVersion(refund) }] }, requestId: 'delete-child', scope: s.app.scope });
      expect(result.state).toBe('partial'); expect(result.items.find((item) => item.id === childId)?.state).toBe('succeeded');
      expect(repo.readBill(s.app.scope, sourceId)?.relations).toHaveLength(1);
      const wire = asBillObject(asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)).bills); expect(wire.changelist).toEqual([]);
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(repo.readBill(s.app.scope, sourceId)?.relations).toEqual([]); expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('reconciles an unknown create only from a unique matching new source child and never repeats refund2', async () => {
    const s = await setup(); s.upstream.respond(async () => { throw new Error('lost response'); });
    await s.app.repository(async (repo) => {
      const handler = createRefundMutationHandler({ reconcileSource: async (ctx) => {
        await expect(ctx.client.request('bill.refund', {}, s.app.scope)).rejects.toThrow('READ_ONLY_PROTOCOL');
        s.clock.advance(1);
        repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(child())], deletes: [], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true;
      } });
      const coordinator = new Coordinator({ repository: repo, client: s.upstream.client, clock: s.clock }, new Map([['ledger.refund', handler]]));
      const result = await coordinator.submit(s.command()); expect(result.state).toBe('uncertain');
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('does not confirm an unknown refund from another child whose tags disagree with the intent', async () => {
    const s = await setup(); s.upstream.respond(async () => { throw new Error('lost response'); });
    await s.app.repository(async (repo) => {
      repo.createDataset(s.app.scope, 'tags', 'tags'); repo.applyPage(s.app.scope, 'tags', { upserts: [], deletes: [], resources: [{ id: 'wanted', kind: 'tag', raw: { id: 'wanted', name: 'wanted' } }], pageState: null, complete: true }, 'tags'); repo.switchDataset(s.app.scope, 'tags', 'tags', null);
      const different = asBillObject(child()); different.extra = { ...billExtra(different), tags: ['other'] };
      const handler = createRefundMutationHandler({ reconcileSource: async () => { s.clock.advance(1); repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(different)], deletes: [], resources: [], pageState: null, validatedAt: s.clock.nowIso(), complete: true }); return true; } });
      const coordinator = new Coordinator({ repository: repo, client: s.upstream.client, clock: s.clock }, new Map([['ledger.refund', handler]]));
      const result = await coordinator.submit(s.command({ tagIds: ['wanted'] }));
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('uncertain'); expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('retains a confirmed parent deletion while an unacknowledged child stays unknown across restart', async () => {
    const s = await setup();
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated), projectBill(child())], deletes: [], resources: [], pageState: null }));
    s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[],"update_ids":[],"del_ids":[${sourceId}],"conf_ids":[],"has_failed":true}}}}`));
    const command = { action: 'ledger.delete', input: { bills: [{ id: sourceId, expectedVersion: billVersion(s.updated) }] }, requestId: 'partial-delete', scope: s.app.scope };
    const result = await s.run((coordinator) => coordinator.submit(command));
    expect(result.items.map((item) => item.state)).toEqual(['succeeded', 'uncertain']);
    await s.app.restart(); await s.run(async (coordinator) => { await coordinator.recover(); expect((await coordinator.submit(command)).id).toBe(result.id); });
    expect(s.upstream.calls).toHaveLength(1);
  });
  it('deduplicates a legacy/new refund link and computes deletion rollback once for each real record', async () => {
    const s = await setup(), raw = { ...s.updated, assetid: 10, extra: { rfds: { [childId]: 30 }, refundid: parseWire(childId), refundv: 30 } }, refund = child('30', '10');
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw), projectBill(refund)], deletes: [], resources: [], pageState: null }));
    s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","del_ids":[${sourceId},${childId}],"has_failed":false}}}}`));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.delete', input: { bills: [{ id: sourceId, expectedVersion: billVersion(raw) }] }, requestId: 'dedupe-delete', scope: s.app.scope }));
    expect(result.state).toBe('succeeded'); expect(result.items).toHaveLength(2);
    expect(addMoney(...result.items.flatMap((item) => item.assetEffects?.map((effect) => effect.delta) ?? []))).toBe('70');
  });
  it('refuses to delete a parent while its referenced refund is missing from the loaded mirror', async () => {
    const s = await setup();
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated)], deletes: [], resources: [], pageState: null }));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'ledger.delete', input: { bills: [{ id: sourceId, expectedVersion: billVersion(s.updated) }] }, requestId: 'missing-child', scope: s.app.scope }));
    expect(result.error?.code).toBe('RELATED_BILL_MISSING'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('rolls back the old historical currency amount and credits a different-currency asset, then reverses the actual child on deletion', async () => {
    const s = await setup(), rawSource = asBillObject(source()); rawSource.assetid = 10;
    rawSource.extra = { curr: { ss: 'USD', sv: 100, ts: 'USD', tv: 100, bs: 'CNY', bv: 720 }, rfds: { [childId]: 5 } };
    const old = asBillObject(child('5', '10')); old.extra = { refundsid: parseWire(sourceId), curr: { ss: 'USD', sv: 5, ts: 'USD', tv: 5, bs: 'CNY', bv: 36 } };
    await s.app.repository((repo) => {
      repo.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '10', kind: 'asset', raw: { id: 10, currency: 'USD', money: '1000', type: 0 } }], pageState: null }, 'assets');
      repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(rawSource), projectBill(old)], deletes: [], resources: [], pageState: null });
    });
    const next = asBillObject(child('36', '20')); next.extra = { refundsid: parseWire(sourceId), curr: { ss: 'USD', sv: 5, ts: 'CNY', tv: 36, bs: 'CNY', bv: 36 } };
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: [rawSource, next] })));
    const edited = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(rawSource), refundBillId: childId, refundExpectedVersion: billVersion(old), money: '5', assetId: '20', currency: { srcSymbol: 'USD', srcValue: '5', targetSymbol: 'CNY', targetValue: '36', baseSymbol: 'CNY', baseValue: '36' } })));
    expect(edited.state).toBe('succeeded'); expect(edited.items[0]?.assetEffects?.map((effect) => [effect.assetId, effect.delta, effect.currency])).toEqual([['10', '-5', 'USD'], ['20', '36', 'CNY']]);
    s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","del_ids":[${sourceId},${childId}],"has_failed":false}}}}`));
    const removed = await s.run((coordinator) => coordinator.submit({ action: 'ledger.delete', input: { bills: [{ id: sourceId, expectedVersion: billVersion(rawSource) }] }, requestId: 'cross-currency-delete', scope: s.app.scope }));
    expect(removed.state).toBe('succeeded'); expect(removed.items.flatMap((item) => item.assetEffects?.map((effect) => [effect.assetId, effect.delta, effect.currency]) ?? [])).toEqual([['10', '100', 'USD'], ['20', '-36', 'CNY']]);
  });
});
