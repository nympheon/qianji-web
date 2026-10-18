import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { ResourceCache } from '../../src/storage/cache';
import { Coordinator } from '../../src/actor/coordinator';
import { BudgetService } from '../../src/features/budget/service';
import { createBudgetMutationHandler } from '../../src/features/budget/use-cases';
import { asBillObject, numericText } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import { summarizeBill } from '../../src/features/ledger/model';
import { projectBill } from '../../src/features/sync/incremental';
import { businessRange } from '../../src/shared/dates';
import type { BillDetail } from '../../src/features/ledger/contract';
import { createActorContext } from '../../src/actor/context';
import { calculateBudget } from '../../src/features/budget/calculate';
const query = { bookId: '1', date: { kind: 'month' as const, year: 2026, month: 10 }, range: 'm10', zone: 'Asia/Shanghai' }, config = { budgetid: '9001', bookid: '1', type: 1, typeinfo: '2026,10', flag: 1, cateid: -1, money: '1000', used: '0', count: 0 };
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.UTC(2026, 9, 18)), upstream = createUpstream(clock, app.scope), data = { list: [structuredClone(config)], daystats: [{ datetime: 1791590400, spend: '100', totalspend: '100' }] };
  const freshness = { revision: 'ledger:1', complete: true, stale: false, syncedAt: clock.nowIso() }, source = { bills: [] as BillDetail[], range: businessRange(query.date, { monthStartDay: 10 }, query.zone), freshness, incompleteReasons: [] as string[], categories: [{ id: '10', parentId: null }, { id: '11', parentId: '10' }] };
  await app.repository((r) => { r.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); r.createDataset(app.scope, 'books', 'books'); r.applyPage(app.scope, 'books', { upserts: [], deletes: [], resources: [{ id: '1', kind: 'book', raw: { bookid: 1, name: 'test', userid: app.scope.uid } }], pageState: null, complete: true }, 'books'); r.switchDataset(app.scope, 'books', 'books', null); r.createDataset(app.scope, 'ledger', 'ledger'); r.applyPage(app.scope, 'ledger', { upserts: [], deletes: [], resources: source.categories.map((category) => ({ id: category.id, kind: 'category', raw: { id: category.id, bookid: '1', type: 0, parentid: category.parentId ?? -1, name: 'category' } })), pageState: null, complete: true }); r.switchDataset(app.scope, 'ledger', 'ledger', null); });
  upstream.respond(async () => new Response(stringifyWire({ ec: 200, data })));
  const service = <T>(fn: (s: BudgetService) => Promise<T>) => app.repository((repository) => fn(new BudgetService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope }, ledger: { budgetSource: async () => source }, baseCurrency: () => 'CNY' })));
  const run = <T>(fn: (c: Coordinator) => Promise<T>) => app.repository((repository) => fn(new Coordinator({ repository, clock, client: upstream.client }, new Map([['budget.submit', createBudgetMutationHandler()]]))));
  return { app, clock, upstream, data, source, service, run };
}
describe('native budget configuration and progress', () => {
  it('submits the complete native budget collection and removes zero goals instead of posting zero money',async()=>{
    const s=await setup();s.data.list.push({...config,budgetid:'9002',flag:2,cateid:10,money:'100'});let saved:ReturnType<typeof asBillObject>[]=[];
    s.upstream.respond(async()=>{const call=s.upstream.calls.at(-1)!;if(call.url.endsWith('/submitv2')){saved=(parseWire(new URLSearchParams(call.body).get('changelist')!) as import('../../src/shared/wire-json').WireJson[]).map(asBillObject);return new Response(stringifyWire({ec:200,data:{list:saved}}));}return new Response(stringifyWire({ec:200,data:s.data}));});
    const before=await s.service(v=>v.list(query));const op=await s.run(c=>c.submit({action:'budget.submit',scope:s.app.scope,requestId:'remove-one-preserve-other',input:{...query,expectedVersion:before.editVersion,changes:[{categoryId:'10',limit:'0'}]}}));expect(op.state).toBe('succeeded');expect(saved.map(row=>[numericText(row.budgetid,''),numericText(row.money,'')])).toEqual([['9001','1000']]);
  });
  it('uses the shared ledger hydration to reflect a later-period refund in the historical source budget', async () => {
    const s = await setup(); await s.app.repository(async (r, storage) => {
      r.sql.exec("UPDATE connection SET state='disconnected' WHERE singleton=1").toArray(); const sourceBill = { id: '1001', bookid: '1', type: 0, money: '100', time: 1792272000, cateid: '11', extra: {} };
      r.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(sourceBill)], deletes: [], resources: [], pageState: null, complete: true }); const ctx = createActorContext(storage), filter = { bookIds: ['1'], date: { kind: 'month' as const, year: 2026, month: 10 }, includeHiddenBooks: true };
      const initial = await ctx.ledger.budgetSource(filter); expect(calculateBudget({ ...initial, budgets: [{ id: 'total', categoryId: null, limit: '1000' }], currency: 'CNY', nowSec: 1792272000 }).used).toBe('100');
      r.applyPage(s.app.scope, 'ledger', { upserts: [projectBill({ ...sourceBill, extra: { rfds: { '1002': '30' } } }), projectBill({ id: '1002', bookid: '1', type: 20, money: '30', time: 1794950400, extra: { refundsid: '1001' } })], deletes: [], resources: [], pageState: null, complete: true });
      const updated = await ctx.ledger.budgetSource(filter); expect(updated.bills).toHaveLength(1); expect(updated.freshness.revision).not.toBe(initial.freshness.revision); expect(calculateBudget({ ...updated, budgets: [{ id: 'total', categoryId: null, limit: '1000' }], currency: 'CNY', nowSec: 1792272000 }).used).toBe('70');
    });
  });
  it('reconciles a lost submission by exact decimal goals without resending it', async () => {
    const s = await setup(), prior = await s.service((v) => v.list(query)); s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.includes('/submitv2')) { s.data.list[0]!.money = '1100.00'; throw new Error('lost response'); } return new Response(stringifyWire({ ec: 200, data: s.data })); }); const lost = await s.run((c) => c.submit({ action: 'budget.submit', input: { ...query, expectedVersion: prior.editVersion, changes: [{ categoryId: null, limit: '1100' }] }, requestId: 'lost-budget', scope: s.app.scope })); const checked = lost.state === 'succeeded' ? lost : await s.run((c) => c.reconcileOperation(s.app.scope, lost.id)); expect(checked.state).toBe('succeeded'); expect(s.upstream.calls.filter((call) => call.url.includes('/submitv2'))).toHaveLength(1);
  });
  it('does not invalidate a draft when only used totals or decimal formatting changes', async () => {
    const s = await setup(), prior = await s.service((v) => v.list(query)); Object.assign(s.data.list[0]!, { money: '1000.00', used: '200', count: 2 }); s.clock.advance(61_000); expect((await s.service((v) => v.list(query))).editVersion).toBe(prior.editVersion);
  });
  it('separates exact dates and native ranges and reuses empty validated sources without polling', async () => {
    const s = await setup(); s.data.list = []; await s.service((v) => v.list(query)); await s.service((v) => v.list(query)); expect(s.upstream.calls).toHaveLength(1); await s.service((v) => v.list({ ...query, range: '' })); await s.service((v) => v.list({ ...query, date: { kind: 'year', year: 2026 } })); expect(s.upstream.calls).toHaveLength(3); const form = new URLSearchParams(s.upstream.calls[0]!.body); expect(JSON.parse(form.get('flts')!)).toEqual({ month: '2026,10' }); expect(form.get('range')).toBe('m10');
  });
  it('applies the authoritative returned budget collection rather than copying submitted values', async () => {
    const s = await setup(), prior = await s.service((v) => v.list(query)); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/submitv2') ? { ...s.data, list: [{ ...config, money: '1200', serverUnknown: 'keep' }] } : s.data })));
    const op = await s.run((c) => c.submit({ action: 'budget.submit', requestId: 'budget-write', scope: s.app.scope, input: { ...query, expectedVersion: prior.editVersion, changes: [{ categoryId: null, limit: '1100' }] } })); expect(op.state).toBe('succeeded'); const after = await s.service((v) => v.list(query)); expect(after.configurations[0]!.limit).toBe('1200'); const form = new URLSearchParams(s.upstream.calls.find((call) => call.url.includes('/submitv2'))!.body), raw = asBillObject((parseWire(form.get('changelist')!) as import('../../src/shared/wire-json').WireJson[])[0]); expect(numericText(raw.money, '')).toBe('1100'); expect(raw.category).toBeUndefined(); expect(raw.createtime).toBeUndefined();
  });
  it('counts one spend at parent and child while keeping total100 and independent not-budget/statistics flags', async () => {
    const s = await setup(); s.data.list.push({ ...config, budgetid: '9002', flag: 2, cateid: 10, money: '500' }, { ...config, budgetid: '9003', flag: 2, cateid: 11, money: '300' });
    const bill = summarizeBill(projectBill({ id: '1001', bookid: 1, type: 0, money: '100', time: 1792272000, cateid: '11', extra: { flag: 1 } })); s.source.bills.push({ ...bill, missingRelatedIds: [], sources: [], incompleteReasons: [], refunds: [], reimbursements: [], freshness: s.source.freshness, editVersion: 'a'.repeat(64) });
    const value = await s.service((v) => v.list(query)); expect(value.progress.used).toBe('100'); expect(value.progress.rows.map((row) => row.used)).toEqual(['100', '100', '100']); s.source.bills[0]!.flags = 2; const excluded = await s.service((v) => v.list(query)); expect(excluded.progress.used).toBe('0'); expect(excluded.progress.totalNotBudget).toBe('100');
  });
  it('keeps unsupported total cancellation unsent after the actual upstream rejection', async () => {
    const s = await setup(), prior = await s.service(v=>v.list(query));const op=await s.run(c=>c.submit({action:'budget.submit',scope:s.app.scope,requestId:'budget-zero',input:{...query,expectedVersion:prior.editVersion,changes:[{categoryId:null,limit:'0'}]}}));expect(op.error?.code).toBe('BUDGET_TOTAL_CANCEL_UNVERIFIED');expect(s.upstream.calls.some(call=>call.url.includes('/submitv2'))).toBe(false);
  });
});
