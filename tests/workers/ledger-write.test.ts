import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { createLedgerMutationHandler } from '../../src/features/ledger/write';
import { asBillObject, billExtra, numericText } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire, type WireJson } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import type { MutationCommand } from '../../src/operations/contract';
import { LedgerWriteService } from '../../src/features/ledger/write-service';
import { ResourceCache } from '../../src/storage/cache';
import { ImageConfiguration } from '../../src/features/attachments/configuration';

const fixture = '{"id":1792000000123100001,"bookid":1,"type":0,"money":90,"time":1792000000,"updatetime":1792000000,"status":1,"userid":"user-A","assetid":-1,"cateid":2,"remark":"original","extra":{"transfee":-10,"flag":64,"future":{"long":9223372036854775801}},"serverFuture":{"keep":true}}';
const version = (raw: WireJson) => createHash('sha256').update(stringifyWire(raw)).digest('hex');
async function scenario() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope);
  const original = projectBill(parseWire(fixture));
  await app.repository((repo) => {
    repo.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
    for (const domain of ['books', 'ledger'] as const) {
      repo.createDataset(app.scope, domain, domain);
    }
    repo.applyPage(app.scope, 'books', { upserts: [], deletes: [], resources: [{ id: '1', kind: 'book', raw: { bookid: 1, name: 'test', visible: 1 } }], pageState: null, complete: true }, 'books');
    repo.applyPage(app.scope, 'ledger', { upserts: [original], deletes: [], resources: [{ id: '2', kind: 'category', raw: { id: 2, bookid: 1, type: 0, name: 'test' } }], pageState: null, complete: true });
    repo.switchDataset(app.scope, 'ledger', 'ledger', null); repo.switchDataset(app.scope, 'books', 'books', null);
  });
  const handler = createLedgerMutationHandler();
  const command = (action: string, input: WireJson, requestId: string = crypto.randomUUID()): MutationCommand => ({ action, input, requestId, scope: app.scope });
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => fn(new Coordinator({ repository, client: upstream.client, clock }, new Map(['ledger.create', 'ledger.edit', 'ledger.delete'].map((action) => [action, handler])))));
  function sent() {
    return upstream.calls.map((call) => {
      const form = new URLSearchParams(call.body), v = asBillObject(parseWire(form.get('v')!)), bills = asBillObject(v.bills);
      return { changed: (bills.changelist as WireJson[]).map(asBillObject), deleted: bills.dellist as WireJson[], text: form.get('v')! };
    });
  }
  const receipt = (newIds: string[] = [], updateIds: string[] = [], delIds: string[] = [], confIds: string[] = []) => new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[${newIds}],"update_ids":[${updateIds}],"del_ids":[${delIds}],"conf_ids":[${confIds}],"has_failed":${confIds.length > 0}}}}}`);
  const newInput = (overrides = {}) => ({ bookId: '1', categoryId: '2', type: 0 as const, enteredMoney: '100', fee: '-10', timeSec: 1792000000, remark: 'test', ...overrides });
  return { app, clock, upstream, original, command, run, sent, receipt, newInput };
}

describe('native bill writes', () => {
  it('rejects contradictory target and base values for the same currency before sending',async()=>{
    const s=await scenario();await s.app.repository(repository=>new ResourceCache(repository,s.clock).confirmResources(s.app.scope,'assets',[{id:'20',kind:'asset',raw:{id:'20',type:1,currency:'CNY',money:'1000'}}]));const result=await s.run(c=>c.submit(s.command('ledger.create',{bills:[s.newInput({assetId:'20',currency:{srcSymbol:'USD',srcValue:'100',targetSymbol:'CNY',targetValue:'630',baseSymbol:'CNY',baseValue:'631'}})]})));expect(result.error?.code).toBe('BILL_CURRENCY_INVALID');expect(s.upstream.calls).toHaveLength(0);
  });
  it('deducts a discount once when all three ordinary historical currency symbols match',async()=>{
    const s=await scenario();s.upstream.respond(async()=>s.receipt([numericText(s.sent()[0]!.changed[0]!.id,'')]));const result=await s.run(c=>c.submit(s.command('ledger.create',{bills:[s.newInput({currency:{srcSymbol:'CNY',srcValue:'100',targetSymbol:'CNY',targetValue:'90',baseSymbol:'CNY',baseValue:'90'}})]})));expect(result.state).toBe('succeeded');expect(numericText(s.sent()[0]!.changed[0]!.money,'')).toBe('90');
  });
  it('retains old historical currency and asset amount when only a foreign bill remark changes',async()=>{
    const s=await scenario(),raw={...asBillObject(s.original.raw),money:630,assetid:20,extra:{...billExtra(asBillObject(s.original.raw)),curr:{ss:'USD',sv:100,ts:'CNY',tv:630,bs:'EUR',bv:80,future:'keep'}}};await s.app.repository(repository=>{new ResourceCache(repository,s.clock).confirmResources(s.app.scope,'assets',[{id:'20',kind:'asset',raw:{id:'20',type:1,currency:'CNY',money:'1000'}}]);repository.applyPage(s.app.scope,'ledger',{upserts:[projectBill(raw)],deletes:[],resources:[],pageState:null});});s.upstream.respond(async()=>s.receipt([],[s.original.id]));const result=await s.run(c=>c.submit(s.command('ledger.edit',{bills:[{id:s.original.id,expectedVersion:version(raw),changes:{remark:'changed'}}]})));expect(result.state).toBe('succeeded');const sent=s.sent()[0]!.changed[0]!;expect(numericText(sent.money,'')).toBe('630');expect(asBillObject(billExtra(sent).curr)).toMatchObject({bs:'EUR',future:'keep'});
  });
  it('stores native ordinary foreign money in the selected asset currency and preserves source gross amount',async()=>{
    const s=await scenario();await s.app.repository(repository=>new ResourceCache(repository,s.clock).confirmResources(s.app.scope,'assets',[{id:'20',kind:'asset',raw:{id:'20',type:1,currency:'CNY',money:'1000'}}]));s.upstream.respond(async()=>s.receipt([numericText(s.sent()[0]!.changed[0]!.id,'')]));const currency={srcSymbol:'USD',srcValue:'100',targetSymbol:'CNY',targetValue:'630',baseSymbol:'CNY',baseValue:'630'},result=await s.run(c=>c.submit(s.command('ledger.create',{bills:[s.newInput({assetId:'20',currency})]})));expect(result.state).toBe('succeeded');const sent=s.sent()[0]!.changed[0]!;expect(numericText(sent.money,'')).toBe('630');expect(numericText(billExtra(sent).transfee,'')).toBe('-10');expect(numericText(asBillObject(billExtra(sent).curr).sv,'')).toBe('100');
  });
  it('does not interpret a new foreign-asset bill as a base-currency bill without a verified currency payload',async()=>{
    const s=await scenario();await s.app.repository(repository=>new ResourceCache(repository,s.clock).confirmResources(s.app.scope,'assets',[{id:'10',kind:'asset',raw:{id:'10',type:1,currency:'USD',money:'100'}}]));const result=await s.run(c=>c.submit(s.command('ledger.create',{bills:[s.newInput({assetId:'10'})]})));expect(result.error?.code).toBe('CURRENCY_REQUIRED');expect(s.upstream.calls).toHaveLength(0);
  });
  it('associates a newly confirmed bill image key and refuses a plain URL as new-upload proof', async () => {
    const s = await scenario(), key = '_' + 'a'.repeat(32); await s.app.repository((repository) => new ResourceCache(repository, s.clock).confirmResources(s.app.scope, 'attachments', [{ id: key, kind: 'attachment', raw: { key, purpose: 'bill', proof: 'qiniu-receipt' } }]));
    s.upstream.respond(async () => s.receipt(s.sent().at(-1)!.changed.map((bill) => numericText(bill.id, '')))); const accepted = await s.run((c) => c.submit(s.command('ledger.create', { bills: [s.newInput({ images: [key] })] }))); expect(accepted.state).toBe('succeeded'); expect(s.sent()[0]!.changed[0]!.images).toEqual([key]); const refused = await s.run((c) => c.submit(s.command('ledger.create', { bills: [s.newInput({ images: ['https://example.test/picture.jpg'] })] }))); expect(refused.error?.code).toBe('IMAGE_UPLOAD_REQUIRED'); expect(s.upstream.calls).toHaveLength(1);
  });
  it('takes the image count from current official configuration instead of the old default6', async () => {
    const s = await scenario(), keys = ['a', 'b', 'c'].map((value) => '_' + value.repeat(32)); await s.app.repository((repository) => { new ImageConfiguration({ repository, clock: s.clock }).applyOfficial(s.app.scope, { max_bill_image: '2' }); new ResourceCache(repository, s.clock).confirmResources(s.app.scope, 'attachments', keys.map((key) => ({ id: key, kind: 'attachment', raw: { key, purpose: 'bill', proof: 'qiniu-receipt' } }))); }); const refused = await s.run((c) => c.submit(s.command('ledger.create', { bills: [s.newInput({ images: keys })] }))); expect(refused.error?.code).toBe('IMAGE_COUNT_LIMIT'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('saves entered100/coupon-10 as money90 exactly once with a native-range long numeric ID', async () => {
    const s = await scenario();
    s.upstream.respond(async () => s.receipt(s.sent().at(-1)!.changed.map((bill) => numericText(bill.id, ''))));
    const cmd = s.command('ledger.create', { bills: [s.newInput()] });
    await s.run(async (coordinator) => {
      const result = await coordinator.submit(cmd);
      expect(result.state).toBe('succeeded');
      expect((await coordinator.submit(cmd)).id).toBe(result.id);
      await expect(coordinator.submit({ ...cmd, input: { bills: [s.newInput({ enteredMoney: '200' })] } })).rejects.toThrow('REQUEST_KEY_REUSED');
    });
    expect(s.upstream.calls).toHaveLength(1);
    const wire = s.sent()[0]!.changed[0]!;
    expect(numericText(wire.money, '')).toBe('90'); expect(numericText(billExtra(wire).transfee, '')).toBe('-10');
    expect(s.sent()[0]!.text).toMatch(/"id":\d{19}/);
    expect(Number(BigInt(numericText(wire.id, '')) % 1_000_000n)).toBeLessThan(200000);
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, numericText(wire.id, ''))?.money).toBe('90'); expect(numericText(asBillObject(repo.readBill(s.app.scope, numericText(wire.id, ''))!.raw).status, '')).toBe('1'); expect(repo.sourceGeneration(s.app.scope, 'assets')).toBe(0); });
  });

  it('patches existing whole records without recalculating money or discarding unknown extra/flag fields', async () => {
    const s = await scenario(); s.upstream.respond(async () => s.receipt([], [s.original.id]));
    const result = await s.run((coordinator) => coordinator.submit(s.command('ledger.edit', { bills: [{ id: s.original.id, expectedVersion: version(s.original.raw), changes: { remark: 'edited', countInBudget: false } }] })));
    expect(result.state).toBe('succeeded');
    const wire = s.sent()[0]!.changed[0]!;
    expect(wire.remark).toBe('edited'); expect(numericText(wire.money, '')).toBe('90');
    expect(numericText(billExtra(wire).flag, '')).toBe('66');
    expect(stringifyWire(billExtra(wire).future!)).toBe('{"long":9223372036854775801}');
    expect(wire.serverFuture).toEqual({ keep: true });
  });

  it('refuses changed drafts, unsupported fees and deleting a source with related refunds before sending', async () => {
    const s = await scenario();
    const invalid = await s.run((coordinator) => coordinator.submit(s.command('ledger.edit', { bills: [{ id: s.original.id, expectedVersion: '0'.repeat(64), changes: { remark: 'stale' } }] })));
    expect(invalid.error?.code).toBe('DRAFT_SOURCE_CHANGED');
    const fee = await s.run((coordinator) => coordinator.submit(s.command('ledger.create', { bills: [s.newInput({ fee: '10' })] })));
    expect(fee.error?.code).toBe('ORDINARY_FEE_UNSUPPORTED');
    const raw = asBillObject(parseWire(fixture)); raw.extra = { rfds: { '1792000000123100010': 1 } };
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw)], deletes: [], resources: [], pageState: null }));
    const related = await s.run((coordinator) => coordinator.submit(s.command('ledger.delete', { bills: [{ id: s.original.id, expectedVersion: version(raw) }] })));
    expect(related.error?.code).toBe('RELATED_BILL_WRITE_UNAVAILABLE');
    expect(s.upstream.calls).toHaveLength(0);
  });

  it('reassigns only explicitly rejected NEW IDs and persists the map before another send', async () => {
    const s = await scenario(); let first = '';
    s.upstream.respond(async () => {
      const id = numericText(s.sent().at(-1)!.changed[0]!.id, '');
      if (s.upstream.calls.length === 1) { first = id; return s.receipt([], [], [], [id]); }
      return s.receipt([id]);
    });
    const result = await s.run((coordinator) => coordinator.submit(s.command('ledger.create', { bills: [s.newInput()] })));
    expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(2);
    expect(result.idMap[first]).toBe(numericText(s.sent()[1]!.changed[0]!.id, ''));
    expect(result.idMap[first]).not.toBe(first);
  });

  it('never reassigns an edit ID or retries unknown/missing acknowledgements', async () => {
    const s = await scenario(); s.upstream.respond(async () => s.receipt([], [], [], [s.original.id]));
    const cmd = s.command('ledger.edit', { bills: [{ id: s.original.id, expectedVersion: version(s.original.raw), changes: { remark: 'changed' } }] });
    const result = await s.run((coordinator) => coordinator.submit(cmd));
    expect(result.state).toBe('failed'); expect(result.items[0]?.error?.code).toBe('EXISTING_ID_REJECTED');
    expect(result.idMap).toEqual({}); expect(s.upstream.calls).toHaveLength(1);
    s.upstream.respond(async () => s.receipt());
    const unknownCmd = s.command('ledger.create', { bills: [s.newInput()] });
    await s.run(async (coordinator) => {
      const unknown = await coordinator.submit(unknownCmd); expect(unknown.state).toBe('uncertain');
      expect((await coordinator.submit(unknownCmd)).id).toBe(unknown.id);
      expect(s.upstream.calls).toHaveLength(2);
    });
  });

  it('persists the first200 successes when the second batch loses its response; restart never resends them', async () => {
    const s = await scenario();
    s.upstream.respond(async () => {
      if (s.upstream.calls.length > 1) throw new Error('response lost');
      return s.receipt(s.sent()[0]!.changed.map((bill) => numericText(bill.id, '')));
    });
    const cmd = s.command('ledger.create', { bills: Array.from({ length: 201 }, () => s.newInput()) });
    const result = await s.run((coordinator) => coordinator.submit(cmd));
    expect(result.state).toBe('partial'); expect(result.items.filter((item) => item.state === 'succeeded')).toHaveLength(200);
    expect(result.items.at(-1)?.state).toBe('uncertain'); expect(s.upstream.calls).toHaveLength(2);
    await s.app.restart();
    await s.run(async (coordinator) => { await coordinator.recover(); await coordinator.submit(cmd); });
    expect(s.upstream.calls).toHaveLength(2);
  });

  it('bounds one original push to five batches and rejects malformed or wrong-UID receipts without success', async () => {
    const s = await scenario();
    s.upstream.respond(async () => s.receipt([], [], [], [numericText(s.sent().at(-1)!.changed[0]!.id, '')]));
    const result = await s.run((coordinator) => coordinator.submit(s.command('ledger.create', { bills: [s.newInput()] })));
    expect(s.upstream.calls).toHaveLength(5); expect(result.state).toBe('failed');
    expect(result.items[0]?.error?.code).toBe('ID_CONFLICT_LIMIT');
    s.upstream.respond(async () => new Response('{"ec":200,"data":{"sync_result":{"bill":{"userid":"other","new_ids":[],"has_failed":false}}}}'));
    const bad = await s.run((coordinator) => coordinator.submit(s.command('ledger.create', { bills: [s.newInput()] })));
    expect(bad.state).toBe('uncertain');
  });

  it('deletes only acknowledged real IDs and preserves the current successful cursor/check time', async () => {
    const s = await scenario(); s.upstream.respond(async () => s.receipt([], [], [s.original.id]));
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [], deletes: [], resources: [], pageState: null, cursor: { old: 'cursor' }, validatedAt: '2026-01-01T00:00:00Z' }));
    const result = await s.run((coordinator) => coordinator.submit(s.command('ledger.delete', { bills: [{ id: s.original.id, expectedVersion: version(s.original.raw) }] })));
    expect(result.state).toBe('succeeded'); expect(s.sent()[0]!.changed).toEqual([]);
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, s.original.id)).toBeNull(); expect(repo.dataset(s.app.scope, 'ledger')?.validatedAt).toBe('2026-01-01T00:00:00Z'); expect(repo.syncState(s.app.scope, 'ledger', 'ledger')?.cursor).toEqual({ old: 'cursor' }); });
  });

  it('recovers a submitted draft operation by its original request key after a lost browser reply', async () => {
    const s = await scenario(); s.upstream.respond(async () => { throw new Error('lost receipt'); });
    const requestId = 'durable-draft';
    await s.app.repository(async (repository) => {
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.create', createLedgerMutationHandler()]]));
      const service = new LedgerWriteService({ repository, coordinator, connection: { scope: () => s.app.scope } });
      service.saveDraft('new', { kind: 'create', requestId, fields: s.newInput() });
      expect(service.getDraft('new')?.draft.fields.timeSec).toBe(1792000000);
      const result = await coordinator.submit(s.command('ledger.create', { bills: [s.newInput()] }, requestId));
      expect(service.getDraft('new')?.operationId).toBe(result.id);
      expect(() => service.saveDraft('new', { kind: 'create', requestId: 'new-key', fields: s.newInput() })).toThrow('DRAFT_OPERATION_PENDING');
    });
  });

  it('uses read-only post-send source verification to confirm an unknown receipt without resending', async () => {
    const s = await scenario(); s.upstream.respond(async () => { throw new Error('lost receipt'); });
    await s.app.repository(async (repository) => {
      let checked = false;
      const handler = createLedgerMutationHandler({ reconcileSource: async (ctx) => {
        await expect(ctx.client.request('bill.syncall', {}, s.app.scope)).rejects.toThrow('READ_ONLY_PROTOCOL');
        const wire = s.sent()[0]!.changed[0]!;
        ctx.repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill({ ...wire, status: 1 })], deletes: [], resources: [], pageState: null, validatedAt: s.clock.nowIso() }); checked = true; return true;
      } });
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.create', handler]]));
      const result = await coordinator.submit(s.command('ledger.create', { bills: [s.newInput()] }));
      expect(result.state).toBe('uncertain');
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded');
      expect(checked).toBe(true); expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('allows a new draft after a partial batch whose every item has a definite result', async () => {
    const s = await scenario();
    s.upstream.respond(async () => {
      const ids = s.sent().at(-1)!.changed.map((bill) => numericText(bill.id, ''));
      return s.upstream.calls.length === 1 ? s.receipt([ids[0]!], [], [], [ids[1]!]) : s.receipt([], [], [], [ids[0]!]);
    });
    await s.app.repository(async (repository) => {
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['ledger.create', createLedgerMutationHandler()]]));
      const service = new LedgerWriteService({ repository, coordinator, connection: { scope: () => s.app.scope } });
      service.saveDraft('batch', { kind: 'create', requestId: 'batch', fields: s.newInput() });
      const result = await coordinator.submit(s.command('ledger.create', { bills: [s.newInput(), s.newInput()] }, 'batch'));
      expect(result.state).toBe('partial'); expect(result.items.map((item) => item.state)).toEqual(['succeeded', 'failed']);
      expect(() => service.saveDraft('batch', { kind: 'create', requestId: 'next-draft', fields: s.newInput() })).not.toThrow();
    });
  });
  it('protects both the old and new assets while an asset-changing bill edit is uncertain', async () => {
    const s = await scenario(), raw = { ...asBillObject(s.original.raw), assetid: 10 };
    await s.app.repository((repo) => {
      repo.createDataset(s.app.scope, 'assets', 'assets');
      repo.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [10, 20].map((id) => ({ id: String(id), kind: 'asset' as const, raw: { id, name: String(id), type: 0, money: 1000 } })), pageState: null, complete: true }, 'assets');
      repo.switchDataset(s.app.scope, 'assets', 'assets', null);
      repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(raw)], deletes: [], resources: [], pageState: null });
    });
    s.upstream.respond(async () => { throw new Error('lost edit response'); });
    await s.run(async (coordinator) => {
      const first = await coordinator.submit(s.command('ledger.edit', { bills: [{ id: s.original.id, expectedVersion: version(raw), changes: { assetId: '20' } }] }));
      expect(first.state).toBe('uncertain'); expect(first.affectedIds).toEqual(expect.arrayContaining(['asset:10', 'asset:20']));
      const held = await coordinator.submit(s.command('ledger.create', { bills: [s.newInput({ assetId: '10' })] }));
      expect(held.state).toBe('queued'); expect(held.error?.code).toBe('TARGET_UNCERTAIN'); expect(s.upstream.calls).toHaveLength(1);
    });
  });
});
