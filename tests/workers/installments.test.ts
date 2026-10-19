import { expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { createInstallmentMutationHandler } from '../../src/features/installments/use-cases';
import { installmentView } from '../../src/features/installments/source';
import { installmentConfigureSchema } from '../../src/features/installments/contract';
import { asBillObject, numericText, moneyText } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire, type WireJson } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import { InstallmentService } from '../../src/features/installments/service';
import { ResourceCache } from '../../src/storage/cache';
const native = () => ({ id: '100', packid: '900', userid: 'user-A', name: 'test', assetid: '20', type: 1, totalmoney: '100', totalfee: '3', totalcount: 3, count: 0, starttime: 1774886400, incount: 1, money: '33.33', fee: '1', status: 1, data: { cateid: '2', category: { id: '2', bookid: '1', type: 0 }, feetype: 'ave', lefttype: 'first', feeincount: 0, prepay: 0, remark: '', images: [], tags: [], unknown: true } });
const createInput = { name: 'new test', bookId: '1', assetId: '20', categoryId: '2', totalMoney: '100', totalFee: '3', totalCount: 12, firstDate: '2026-03-31', time: '00:00', remainder: 'first', feePlacement: 'ave', inCount: true, feeInCount: false };
it('uses the APK constructor defaults when official installment data omits allocation fields',()=>{
 const raw=native(),{feetype:_fee,lefttype:_left,...data}=raw.data;
 expect(installmentView({...raw,totalfee:'0',data})).toMatchObject({remainder:'first',feePlacement:'ave'});
});
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.parse('2026-05-31T12:00:00+08:00')), upstream = createUpstream(clock, app.scope); let current: WireJson = native(), partial = false, sends = 0;
  await app.repository((repository) => { repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); for (const domain of ['ledger', 'books', 'assets'] as const) { repository.createDataset(app.scope, domain, domain); repository.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? [projectBill({ id: '500', userid: app.scope.uid, bookid: '1', type: 0, time: 100, money: '10', packid: '999', extra: {} })] : [], deletes: [], resources: domain === 'books' ? [{ id: '1', kind: 'book', raw: { bookid: '1' } }] : domain === 'ledger' ? [{ id: '2', kind: 'category', raw: { id: '2', bookid: '1', type: 0 } }] : [{ id: '10', kind: 'asset', raw: { id: '10', userid: app.scope.uid, name: 'Cash', type: 1, stype: 11, currency: 'CNY', money: '1000' } }, { id: '20', kind: 'asset', raw: { id: '20', userid: app.scope.uid, name: 'Card', type: 2, stype: 21, currency: 'CNY', money: '0', installs: [] } }], complete: true, validatedAt: clock.nowIso(), pageState: null }, domain); repository.switchDataset(app.scope, domain, domain, null); } });
  upstream.respond(async () => { const call = upstream.calls.at(-1)!, action = new URL(call.url).pathname.split('/').at(-1), params = new URLSearchParams(call.body); if (action === 'list') return new Response(stringifyWire({ ec: 200, data: { list: [current], hasmore: false } })); sends++; const input = asBillObject(parseWire(params.get('v') ?? '{}'));
    if (action === 'submit') { current = { ...input, id: '101', packid: '901', userid: app.scope.uid, status: 1 }; return new Response(stringifyWire({ ec: 200, data: { install: current, bills: [] } })); }
    if (action === 'config') { const raw = asBillObject(current); current = { ...raw, incount: input.incount, data: { ...asBillObject(raw.data), feeincount: input.feeincount } }; return Response.json({ ec: 200 }); }
    if (action === 'prepay') { const raw = asBillObject(current); current = { ...raw, status: -1, data: { ...asBillObject(raw.data), prepay: input.time } }; const common = { userid: app.scope.uid, bookid: '1', time: input.time, money: input.money, packid: '900', extra: {} }, bills = [{ ...common, id: '600', type: 0, assetid: '20' }, ...partial ? [] : [{ ...common, id: '601', type: 3, fromid: '10', targetid: '20', extra: { transfee: input.fee ?? 0 } }]]; return new Response(stringifyWire({ ec: 200, data: { install: current, bills } })); }
    return Response.json({ ec: 200 });
  });
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => { const handler = createInstallmentMutationHandler({ refreshLedger: async () => true }); return fn(new Coordinator({ repository, clock, client: upstream.client }, new Map(['installments.create', 'installments.configure', 'installments.prepay', 'installments.setBillBinding', 'installments.delete'].map((action) => [action, handler])))); });
  return { app, clock, upstream, run, partial: () => { partial = true; }, sends: () => sends, current: () => current };
}
it('submits the native initial count and constructor defaults without uploading locally generated historical bills', async () => {
  const s = await setup(), result = await s.run((coordinator) => coordinator.submit({ action: 'installments.create', scope: s.app.scope, requestId: 'create-native-count', input: createInput })); expect(result, JSON.stringify(result.error)).toMatchObject({ state: 'succeeded' }); const sent = s.upstream.calls.find((call) => call.url.includes('/submit'))!; const wire = asBillObject(parseWire(new URLSearchParams(sent.body).get('v')!)); expect(wire).toMatchObject({ data: { lefttype: 'first', feetype: 'ave' } }); expect(numericText(wire.type, '')).toBe('1'); expect(moneyText(wire.money)).toBe('0'); expect(moneyText(wire.fee)).toBe('0'); expect(installmentView(asBillObject(s.current())).count).toBe(3); expect(s.upstream.calls.some((call) => call.url.includes('/bill/syncall'))).toBe(false);
});
it('configures only incount/feeincount and preserves money, periods and unknown data', async () => {
  const s = await setup(), view = installmentView(native()); const result = await s.run((coordinator) => coordinator.submit({ action: 'installments.configure', scope: s.app.scope, requestId: 'config-counts', input: { id: '100', expectedVersion: view.editVersion, inCount: false, feeInCount: true } })); expect(result.state).toBe('succeeded'); const sent = s.upstream.calls.find((call) => call.url.includes('/config'))!; expect(Object.keys(asBillObject(parseWire(new URLSearchParams(sent.body).get('v')!))).sort()).toEqual(['feeincount', 'incount']); expect(asBillObject(asBillObject(s.current()).data).unknown).toBe(true); expect(installmentConfigureSchema.safeParse({ id: '100', expectedVersion: view.editVersion, inCount: true, feeInCount: true, totalMoney: '200' }).success).toBe(false);
});
it('does not toggle a bill bound toU when unbinding this installmentT', async () => {
  const s = await setup(), result = await s.run((coordinator) => coordinator.submit({ action: 'installments.setBillBinding', scope: s.app.scope, requestId: 'unbind-other', input: { planId: '100', packId: '900', billId: '500', bound: false } })); expect(result.state).toBe('succeeded'); expect(s.sends()).toBe(0);
});
it('tracks prepay task, expense and repayment roles independently and never resends a partial result', async () => {
  const s = await setup(); s.partial(); await s.run(async (coordinator) => { const command = { action: 'installments.prepay', scope: s.app.scope, requestId: 'partial-prepay', input: { id: '100', expectedVersion: installmentView(native()).prepayVersion, bookId: '1', fromAssetId: '10', money: '100', fee: '1', timeSec: 1770000000 } }, result = await coordinator.submit(command); expect(result.state).toBe('partial'); expect(result.items.filter((item) => item.state === 'succeeded')).toHaveLength(2); expect(result.items.filter((item) => item.state === 'uncertain')).toHaveLength(1); expect((await coordinator.submit(command)).id).toBe(result.id); expect(s.sends()).toBe(1); });
});
it('refuses unverified prepay image encoding rather than copying the APK remark value into images', async () => {
  const s = await setup(), result = await s.run((coordinator) => coordinator.submit({ action: 'installments.prepay', scope: s.app.scope, requestId: 'image-encoding', input: { id: '100', expectedVersion: installmentView(native()).prepayVersion, bookId: '1', fromAssetId: '10', money: '100', fee: '0', timeSec: 1770000000, images: ['_image'] } })); expect(result.error?.code).toBe('PREPAY_IMAGES_UNVERIFIED'); expect(s.sends()).toBe(0);
});
it('does not confirm a created task when the server changes its timestamp or remark', async () => {
  for (const changed of [{ starttime: 1774890000 }, { data: { ...native().data, remark: 'other intent' } }]) {
    const s = await setup(); s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.endsWith('/list')) return new Response(stringifyWire({ ec: 200, data: { list: [native()], hasmore: false } })); const wire = asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)); return new Response(stringifyWire({ ec: 200, data: { install: { ...wire, id: '101', packid: '901', userid: s.app.scope.uid, status: 1, ...changed }, bills: [] } })); });
    const result = await s.run((coordinator) => coordinator.submit({ action: 'installments.create', scope: s.app.scope, requestId: 'changed-receipt', input: createInput })); expect(result.state).toBe('uncertain');
  }
});
it('uses fresh readonly configuration proof after a lost ACK without resending config', async () => {
  const s = await setup(); let changed = false, writes = 0;
  s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.endsWith('/list')) return new Response(stringifyWire({ ec: 200, data: { list: [{ ...native(), incount: changed ? 0 : 1 }], hasmore: false } })); writes++; changed = true; throw new Error('lost test ACK'); });
  await s.run(async (coordinator) => { const command = { action: 'installments.configure', scope: s.app.scope, requestId: 'lost-config', input: { id: '100', expectedVersion: installmentView(native()).editVersion, inCount: false, feeInCount: false } }, result = await coordinator.submit(command); expect(result.state).toBe('uncertain'); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect((await coordinator.submit(command)).state).toBe('succeeded'); expect(writes).toBe(1); });
});
it('tracks both official prepay bill roles and retains the previous history', async () => {
  const s = await setup(), result = await s.run((coordinator) => coordinator.submit({ action: 'installments.prepay', scope: s.app.scope, requestId: 'full-prepay', input: { id: '100', expectedVersion: installmentView(native()).prepayVersion, bookId: '1', fromAssetId: '10', money: '100', fee: '1', timeSec: 1770000000 } })); expect(result.state).toBe('succeeded'); expect(Object.values(result.idMap).sort()).toEqual(['600', '601']);
  await s.app.repository((repository) => { expect(repository.readBill(s.app.scope, '500')).not.toBeNull(); expect(repository.readBill(s.app.scope, '600')?.type).toBe(0); expect(repository.readBill(s.app.scope, '601')?.type).toBe(3); });
});
it('shares the empty complete catalog across local filters for60s without refreshing on reads', async () => {
  const s = await setup(); s.upstream.respond(async () => Response.json({ ec: 200, data: { list: [], hasmore: false } }));
  await s.app.repository(async (repository) => { const service = new InstallmentService({ repository, clock: s.clock, client: s.upstream.client, connection: { scope: () => s.app.scope }, cache: new ResourceCache(repository, s.clock) }); await Promise.all([service.list({}), service.list({ assetId: '20' })]); s.clock.advance(59000); expect((await service.list({ statuses: [1] })).freshness.complete).toBe(true); expect(s.upstream.calls).toHaveLength(1); s.clock.advance(1001); await service.list({}); expect(s.upstream.calls).toHaveLength(2); });
});
