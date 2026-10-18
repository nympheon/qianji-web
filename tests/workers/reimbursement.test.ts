import { describe, expect, it } from 'vitest';
import { allocateReimbursement, createReimbursementMutationHandler, reimbursementRemaining } from '../../src/features/ledger/reimbursement';
import { asBillObject, numericText, type BillObject } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { projectBill } from '../../src/features/sync/incremental';
import { billVersion } from '../../src/features/ledger/write';
import { Coordinator } from '../../src/actor/coordinator';
import { createLedgerDeletionHandler } from '../../src/features/ledger/deletion';
import { createReimbursableMutationHandler } from '../../src/features/ledger/reimbursement';
import { addMoney } from '../../src/shared/numbers';

const a = '1792000000123100001', b = '1792000000123100002', ca = '1792000000123100011', cb = '1792000000123100012';
const source = (id = a, time = 100, money = '50') => asBillObject(parseWire(`{"id":${id},"bookid":1,"type":5,"money":${money},"time":${time},"userid":"user-A","cateid":2,"extra":{}}`));
const child = (id: string, sid: string, money: string) => parseWire(`{"id":${id},"bookid":1,"type":21,"money":${money},"time":200,"userid":"user-A","assetid":10,"extra":{"bxsid":${sid},"packid":123}}`);
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope), sources = [source(), source(b, 101)];
  await app.repository((repo) => {
    repo.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
    for (const domain of ['ledger', 'assets'] as const) {
      repo.createDataset(app.scope, domain, domain);
      repo.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? sources.map(projectBill) : [], deletes: [], resources: domain === 'assets' ? [{ id: '10', kind: 'asset', raw: { id: 10, type: 0, money: 1000, currency: 'CNY' } }] : [], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain);
      repo.switchDataset(app.scope, domain, domain, null);
    }
  });
  const updated: BillObject[] = sources.map((raw, i) => ({ ...raw, extra: { unknown: true, bxs: { [i === 0 ? ca : cb]: i === 0 ? 50 : 70 } } }));
  upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: { id: 10, type: 0, money: 1120, currency: 'CNY' }, bills: [...updated, child(ca, a, '50'), child(cb, b, '70')] } })));
  const command = (action = 'ledger.reimburse', requestId = crypto.randomUUID()) => ({ action, requestId, scope: app.scope, input: { bills: sources.map((raw) => ({ id: numericText(raw.id, ''), expectedVersion: billVersion(raw) })), assetId: '10', money: '120', timeSec: 200 } });
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => fn(new Coordinator({ repository, client: upstream.client, clock }, new Map([['ledger.reimburse', createReimbursementMutationHandler()], ['ledger.cancelReimbursement', createReimbursementMutationHandler()]]))));
  return { app, clock, upstream, sources, updated, command, run };
}
describe('native reimbursement allocation and receipt', () => {
  it('sorts by time and exact long ID; last source takes residual even beyond principal', () => {
    const allocated = allocateReimbursement([source(b, 100), source(a, 100)], '120');
    expect(Object.keys(allocated)).toEqual([a, b]); expect(numericText(asBillObject(allocated[a]).money, '')).toBe('50'); expect(numericText(asBillObject(allocated[b]).money, '')).toBe('70');
  });
  it('uses V2 priority, refunds and historical source fees without subtracting old-only compatibility', () => {
    const raw = source(); raw.extra = { baoxiaoed: 1, bxmoney: 99, rfds: { '8': 10 }, bxs: { '9': 15 }, curr: { ss: 'USD', sv: 100, ts: 'CNY', tv: 700, bs: 'CNY', bv: 700 } }; raw.fee = 0;
    expect(reimbursementRemaining(raw)).toBe('75'); delete asBillObject(raw.extra).bxs; expect(reimbursementRemaining(raw)).toBe('90');
  });
  it('carries all three historical currency residuals after native ten-place ratio rounding', () => {
    const allocated = allocateReimbursement([source(a, 100, '1'), source(b, 101, '2')], '3', { srcSymbol: 'USD', srcValue: '3', targetSymbol: 'CNY', targetValue: '10', baseSymbol: 'EUR', baseValue: '2' });
    const first = asBillObject(asBillObject(allocated[a]).curr), last = asBillObject(asBillObject(allocated[b]).curr);
    expect(numericText(first.tv, '')).toBe('3.3333333333'); expect(numericText(last.tv, '')).toBe('6.6666666667'); expect(numericText(last.bv, '')).toBe('1.3333333333');
  });
  it('saves the complete real group and replaces official inAsset once; stable key sends once', async () => {
    const s = await setup(), command = s.command();
    await s.run(async (coordinator) => { const result = await coordinator.submit(command); expect(result.state).toBe('succeeded'); expect(result.affectedIds).toEqual(expect.arrayContaining([a, b, ca, cb])); expect((await coordinator.submit(command)).id).toBe(result.id); });
    expect(s.upstream.calls).toHaveLength(1); const call = s.upstream.calls[0]!; expect(call.url).toContain('/baoxiao/baoxiao'); const form = new URLSearchParams(call.body); expect(form.get('did')).toBe('10'); expect(form.get('bxtime')).toBe('200');
    expect(numericText(asBillObject(asBillObject(parseWire(form.get('v')!))[b]).money, '')).toBe('70');
    await s.app.repository((repo) => { expect(numericText(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money, '')).toBe('1120'); expect(repo.readBill(s.app.scope, ca)?.type).toBe(21); expect(repo.sql.exec("SELECT id FROM bills WHERE type=22").toArray()).toHaveLength(0); });
  });
  it('rejects incomplete group receipts atomically and never repeats an unknown mutation', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: { id: 10, money: 1120 }, bills: s.updated } })));
    const command = s.command(); await s.run(async (coordinator) => { expect((await coordinator.submit(command)).state).toBe('uncertain'); expect((await coordinator.submit(command)).state).toBe('uncertain'); });
    expect(s.upstream.calls).toHaveLength(1); await s.app.repository((repo) => { expect(billVersion(repo.readBill(s.app.scope, a)!.raw)).toBe(billVersion(s.sources[0]!)); expect(numericText(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money, '')).toBe('1000'); });
  });
  it('reconciles an unknown reimbursement through an exact new relation group without resending', async () => {
    const s = await setup(); s.upstream.respond(async () => { throw new Error('lost receipt'); });
    await s.app.repository(async (repository) => {
      let matching = false;
      const handler = createReimbursementMutationHandler({ reconcileSource: async (ctx) => {
        await expect(ctx.client.request('bill.reimburse', {}, s.app.scope)).rejects.toThrow('READ_ONLY_PROTOCOL'); s.clock.advance(1);
        repository.applyPage(s.app.scope, 'ledger', { upserts: [...s.updated, child(ca, a, matching ? '50' : '49'), child(cb, b, '70')].map(projectBill), deletes: [], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true;
      } });
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.reimburse', handler]]));
      const result = await coordinator.submit(s.command()); expect(result.state).toBe('uncertain'); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('uncertain');
      matching = true; expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('refuses mixed native source symbols, changed versions and foreign owners before any write', async () => {
    const s = await setup(), different = { ...s.sources[1]!, extra: { curr: { ss: 'CNY', sv: 50, ts: 'CNY', tv: 50, bs: 'CNY', bv: 50 } } };
    await s.app.repository((repository) => repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(different)], deletes: [], resources: [], pageState: null }));
    const command = s.command(); expect((await s.run((coordinator) => coordinator.submit(command))).error?.code).toBe('DRAFT_SOURCE_CHANGED');
    command.input.bills[1]!.expectedVersion = billVersion(different); command.requestId = crypto.randomUUID(); expect((await s.run((coordinator) => coordinator.submit(command))).error?.code).toBe('REIMBURSEMENT_SOURCE_CURRENCIES');
    const foreign = { ...s.sources[0]!, userid: 'someone-else' }; await s.app.repository((repository) => repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(foreign)], deletes: [], resources: [], pageState: null }));
    command.input.bills[0]!.expectedVersion = billVersion(foreign); command.requestId = crypto.randomUUID(); expect((await s.run((coordinator) => coordinator.submit(command))).error?.code).toBe('REIMBURSEMENT_OTHER_USER'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('cancel sends only source IDs and requires read verification, preserving type5 and no fabricated child deletion', async () => {
    const s = await setup(); await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [...s.updated, child(ca, a, '50'), child(cb, b, '70')].map(projectBill), deletes: [], resources: [], pageState: null }));
    s.upstream.respond(async () => new Response('{"ec":200}')); const original = s.command('ledger.cancelReimbursement'); const command = { ...original, input: { bills: s.updated.map((raw) => ({ id: numericText(raw.id, ''), expectedVersion: billVersion(raw) })) } };
    const result = await s.run((coordinator) => coordinator.submit(command)); expect(result.state).toBe('uncertain'); expect(s.upstream.calls[0]!.url).toContain('/baoxiao/cancelbaoxiao'); expect(new URLSearchParams(s.upstream.calls[0]!.body).get('v')).toBe(`[${a},${b}]`);
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, a)?.type).toBe(5); expect(repo.readBill(s.app.scope, ca)).not.toBeNull(); });
  });
  it('cancellation becomes confirmed only after source links, real children and assets pass a post-send read', async () => {
    const s = await setup(); await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [...s.updated, child(ca, a, '50'), child(cb, b, '70')].map(projectBill), deletes: [], resources: [], pageState: null }));
    s.upstream.respond(async () => new Response('{"ec":200}'));
    await s.app.repository(async (repository) => {
      let completeChildren = false;
      const handler = createReimbursementMutationHandler({ reconcileSource: async (ctx) => {
        await expect(ctx.client.request('bill.cancelReimbursement', {}, s.app.scope)).rejects.toThrow('READ_ONLY_PROTOCOL'); s.clock.advance(1);
        repository.applyPage(s.app.scope, 'ledger', { upserts: s.sources.map(projectBill), deletes: completeChildren ? [ca, cb] : [ca], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() });
        repository.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '10', kind: 'asset', raw: { id: 10, type: 0, currency: 'CNY', money: 1000 } }], pageState: null, complete: true, validatedAt: s.clock.nowIso() }, 'assets'); return true;
      } });
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.cancelReimbursement', handler]]));
      const result = await coordinator.submit({ action: 'ledger.cancelReimbursement', requestId: 'cancel-check', scope: s.app.scope, input: { bills: s.updated.map((raw) => ({ id: numericText(raw.id, ''), expectedVersion: billVersion(raw) })) } });
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('uncertain'); completeChildren = true;
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(repository.readBill(s.app.scope, a)?.type).toBe(5); expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('expands reimbursement parent deletion to real children and reverses mixed legacy/current amounts once', async () => {
    const s = await setup(), raw = { ...s.updated[0]!, assetid: 10, extra: { ...asBillObject(s.updated[0]!.extra), baoxiaoed: 1, baoxiaov: 20, baoxiaoasset: 10 } };
    await s.app.repository(async (repository) => {
      repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw), projectBill(child(ca, a, '50'))], deletes: [], resources: [], pageState: null });
      s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","del_ids":[${a},${ca}],"has_failed":false}}}}`));
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.delete', createLedgerDeletionHandler()]]));
      const result = await coordinator.submit({ action: 'ledger.delete', requestId: 'parent-delete', scope: s.app.scope, input: { bills: [{ id: a, expectedVersion: billVersion(raw) }] } });
      expect(result.state).toBe('succeeded'); expect(result.items.map((item) => item.id)).toEqual([a, ca]); expect(addMoney(...result.items.flatMap((item) => item.assetEffects?.map((effect) => effect.delta) ?? []))).toBe('-20');
    });
  });
  it('deleting one real21 leaves source relationship verification pending without uploading a parent change', async () => {
    const s = await setup(), raw = child(ca, a, '50');
    await s.app.repository(async (repository) => {
      repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(s.updated[0]!), projectBill(raw)], deletes: [], resources: [], pageState: null });
      s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","del_ids":[${ca}],"has_failed":false}}}}`));
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.delete', createLedgerDeletionHandler()]]));
      const result = await coordinator.submit({ action: 'ledger.delete', requestId: 'child-delete', scope: s.app.scope, input: { bills: [{ id: ca, expectedVersion: billVersion(raw) }] } });
      expect(result.state).toBe('partial'); expect(result.items.find((item) => item.id === ca)?.state).toBe('succeeded'); expect(result.items.find((item) => item.id === `relations:${a}`)?.state).toBe('uncertain');
      expect(asBillObject(asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)).bills).changelist).toEqual([]);
    });
  });
  it('changes pending attribute with refunds preserved but refuses clearing it while compatibility reimbursement remains', async () => {
    const s = await setup(), raw = { ...s.sources[0]!, type: 0, extra: { rfds: { '99': 10 }, untouched: true } };
    await s.app.repository(async (repository) => {
      repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw)], deletes: [], resources: [], pageState: null });
      s.upstream.respond(async () => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","update_ids":[${a}],"has_failed":false}}}}`));
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.setReimbursable', createReimbursableMutationHandler()]]));
      expect((await coordinator.submit({ action: 'ledger.setReimbursable', requestId: 'mark-pending', scope: s.app.scope, input: { bills: [{ id: a, expectedVersion: billVersion(raw) }], reimbursable: true } })).state).toBe('succeeded');
      const next = asBillObject(repository.readBill(s.app.scope, a)!.raw); expect(numericText(next.type, '')).toBe('5'); expect(stringifyWire(asBillObject(next.extra).rfds!)).toBe(stringifyWire(raw.extra.rfds));
      const linked = { ...next, extra: { ...asBillObject(next.extra), baoxiaoed: 1 } }; repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(linked)], deletes: [], resources: [], pageState: null });
      expect((await coordinator.submit({ action: 'ledger.setReimbursable', requestId: 'unmark-linked', scope: s.app.scope, input: { bills: [{ id: a, expectedVersion: billVersion(linked) }], reimbursable: false } })).error?.code).toBe('REIMBURSEMENT_ATTRIBUTE_LOCKED'); expect(s.upstream.calls).toHaveLength(1);
    });
  });
});
