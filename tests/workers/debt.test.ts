import { describe, expect, it } from 'vitest';
import { debtCashDelta, paymentState, principalState, splitDebtPayment, type DebtState } from '../../src/features/debt/accounting';
import { createDebtMutationHandler, createDebtBillMutationHandler } from '../../src/features/debt/use-cases';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { asBillObject, moneyText, numericText } from '../../src/shared/bill-wire';
import { billVersion } from '../../src/features/ledger/write';
import { projectBill } from '../../src/features/sync/incremental';
import { createLedgerDeletionHandler } from '../../src/features/ledger/deletion';
import { summarizeBill } from '../../src/features/ledger/model';
import { aggregate, toStatItem } from '../../src/features/ledger/statistics';
import { DebtService } from '../../src/features/debt/service';
import { ResourceCache } from '../../src/storage/cache';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import type { WireJson } from '../../src/shared/wire-json';

const borrowed: DebtState = { direction: 'borrow', balance: '-100', totalPrincipal: '-100', totalPaid: '0' };
describe('native principal and interest accounting', () => {
  it('pays borrowed principal30 and interest5: debt-70, paid30, cash once-35', () => {
    const split = splitDebtPayment('-100', '30', '5'); expect(split).toEqual({ principal: '30', interest: '5', overflow: false }); expect(paymentState(borrowed, split.principal)).toEqual({ ...borrowed, balance: '-70', totalPaid: '30' }); expect(debtCashDelta('borrow', 'pay', split.principal, split.interest)).toBe('-35');
  });
  it('applies native G0 overflow normalization: entered120 becomes principal100/interest20', () => {
    expect(splitDebtPayment('-100', '120')).toEqual({ principal: '100', interest: '20', overflow: true }); expect(splitDebtPayment('100', '-120', '5')).toEqual({ principal: '100', interest: '20', overflow: true });
  });
  it('supports pure interest and preserves exact decimal amounts and the native per-field amount bound', () => {
    expect(splitDebtPayment('-100', '0', '0.1234567891')).toEqual({ principal: '0', interest: '0.1234567891', overflow: false }); expect(paymentState(borrowed, '0')).toEqual(borrowed); expect(() => splitDebtPayment('-100', '0', '10000000000')).toThrow('DEBT_AMOUNT_LIMIT');
  });
  it('updates signed LoanInfo principal by edit delta and clamps borrowed/lent balance in its own direction', () => {
    expect(principalState(borrowed, '150', '100')).toEqual({ ...borrowed, balance: '-150', totalPrincipal: '-150' }); expect(principalState({ ...borrowed, totalPaid: '150', balance: '0' }, '50', '100')).toMatchObject({ balance: '0', totalPrincipal: '-50', totalPaid: '150' });
    const lent: DebtState = { direction: 'lend', balance: '70', totalPrincipal: '100', totalPaid: '30' }; expect(principalState(lent, '80', '100')).toEqual({ ...lent, totalPrincipal: '80', balance: '50' }); expect(debtCashDelta('lend', 'pay', '30', '5')).toBe('35');
  });
});
async function debtSetup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope);
  const debt = { id: 100, userid: app.scope.uid, name: '借入', type: 5, stype: 51, money: '-100', currency: 'CNY', status: 0, incount: 1, loan: { money: '-100', totalpay: '0', startdate: '2026-01-01' } };
  await app.repository((repository) => {
    repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
    for (const domain of ['ledger', 'assets', 'books'] as const) { repository.createDataset(app.scope, domain, domain); repository.applyPage(app.scope, domain, { upserts: [], deletes: [], resources: domain === 'books' ? [{ id: '1', kind: 'book', raw: { bookid: 1, name: 'test' } }] : domain === 'assets' ? [{ id: '100', kind: 'asset', raw: debt }, ...['10', '20'].map((id) => ({ id, kind: 'asset' as const, raw: { id, type: 1, stype: 11, name: id, currency: 'CNY', money: '1000', status: 0, incount: 1 } }))] : [], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain); repository.switchDataset(app.scope, domain, domain, null); }
  });
  const sent = () => upstream.calls.map((call) => asBillObject(asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)).bills));
  upstream.respond(async () => { const body = sent().at(-1)!, changed = (body.changelist as WireJson[]).map((raw) => numericText(asBillObject(raw).id, '')), deleted = (body.dellist as WireJson[]).map((raw) => numericText(raw, '')); return new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[${changed}],"update_ids":[],"del_ids":[${deleted}],"conf_ids":[],"has_failed":false}}}}`); });
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => { const handler = createDebtBillMutationHandler(); return fn(new Coordinator({ repository, clock, client: upstream.client }, new Map([...['debt.pay', 'debt.appendPrincipal', 'debt.editPrincipal'].map((action) => [action, handler] as const), ['ledger.delete', createLedgerDeletionHandler()]]))); });
  return { app, clock, upstream, sent, run, debt, input: { id: '100', expectedVersion: billVersion(debt), bookId: '1', aboutAssetId: '10', timeSec: 1767196800, principal: '30', interest: '5', remark: '验收还款' } };
}
describe('debt records and independent receipts', () => {
  it('sends9/30 and10/5 with their native ID fields and separate IDs; spends only interest and preserves confirmed assets', async () => {
    const s = await debtSetup(), result = await s.run((c) => c.submit({ action: 'debt.pay', input: s.input, requestId: 'pay', scope: s.app.scope })); expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/bill/syncall');
    const rows = (s.sent()[0]!.changelist as WireJson[]).map(asBillObject), principal = rows.find((raw) => numericText(raw.type, '') === '9')!, interest = rows.find((raw) => numericText(raw.type, '') === '10')!;
    expect([numericText(principal.assetid, ''), numericText(principal.fromid, ''), moneyText(principal.money)]).toEqual(['100', '10', '30']); expect([numericText(interest.fromid, ''), numericText(interest.assetid, ''), moneyText(interest.money)]).toEqual(['100', '10', '5']); expect(numericText(interest.id, '')).not.toBe(numericText(principal.id, '')); expect(rows.every((raw) => !JSON.stringify(raw).includes('sourceBillId'))).toBe(true);
    expect(result.items.flatMap((item) => item.assetEffects ?? []).filter((item) => item.assetId === '10').map((item) => item.delta)).toEqual(['-30', '-5']);
    const stats = aggregate(rows.map((raw) => { const bill = summarizeBill(projectBill(raw)); return toStatItem({ ...bill, refunds: [], reimbursements: [], sources: [], missingRelatedIds: [], incompleteReasons: [], freshness: { revision: '1', complete: true, stale: false, syncedAt: null } }, 'statistics', 'CNY'); })); expect(stats.totalSpend).toBe('5');
    await s.app.repository((r) => { expect(moneyText(asBillObject(r.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['100'] }).items[0]!.raw).money)).toBe('-100'); expect(moneyText(asBillObject(r.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money)).toBe('1000'); });
  });
  it('normalizes overpayment120 to9/100 and10/20, and creates only interest for zero principal', async () => {
    const s = await debtSetup(); await s.run((c) => c.submit({ action: 'debt.pay', input: { ...s.input, principal: '120' }, requestId: 'overflow', scope: s.app.scope })); expect((s.sent()[0]!.changelist as WireJson[]).map((raw) => moneyText(asBillObject(raw).money))).toEqual(['100', '20']);
    await s.run((c) => c.submit({ action: 'debt.pay', input: { ...s.input, principal: '0' }, requestId: 'interest', scope: s.app.scope })); const only = (s.sent()[1]!.changelist as WireJson[]).map(asBillObject); expect(only).toHaveLength(1); expect(numericText(only[0]!.type, '')).toBe('10');
  });
  it('keeps principal accepted and interest uncertain on a partial receipt, retaining both original IDs on reconciliation', async () => {
    const s = await debtSetup(); s.upstream.respond(async () => { const rows = (s.sent().at(-1)!.changelist as WireJson[]).map(asBillObject), principal = rows.find((raw) => numericText(raw.type, '') === '9')!; return new Response(`{"ec":200,"data":{"sync_result":{"bill":{"userid":"user-A","new_ids":[${numericText(principal.id, '')}],"update_ids":[],"del_ids":[],"conf_ids":[],"has_failed":true}}}}`); });
    const result = await s.run((c) => c.submit({ action: 'debt.pay', input: s.input, requestId: 'partial', scope: s.app.scope })); expect(result.state).toBe('partial'); expect(result.items.map((item) => item.state)).toEqual(['succeeded', 'uncertain']);
    await s.run((c) => c.reconcileOperation(s.app.scope, result.id)); expect(s.upstream.calls).toHaveLength(1); await s.app.repository((r) => expect(r.sql.exec('SELECT id FROM bills').toArray()).toHaveLength(1));
  });
  it('appends principal and edits the old amount with rollback when moving cash accounts', async () => {
    const s = await debtSetup(), { interest: _interest, ...input } = s.input;
    const added = await s.run((c) => c.submit({ action: 'debt.appendPrincipal', input: { ...input, principal: '50' }, requestId: 'append', scope: s.app.scope })); expect(added.state).toBe('succeeded'); expect(added.items[0]?.assetEffects?.map((item) => [item.assetId, item.delta])).toEqual([['100', '-50'], ['10', '50']]);
    const old = { id: '900', userid: s.app.scope.uid, bookid: 1, type: 6, money: '100', time: 10, assetid: 100, targetid: 10, status: 1, extra: {} };
    await s.app.repository((r) => r.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(old)], deletes: [], resources: [], pageState: null }));
    const result = await s.run((c) => c.submit({ action: 'debt.editPrincipal', input: { id: '900', expectedVersion: billVersion(old), changes: { principal: '150', aboutAssetId: '20' } }, requestId: 'edit', scope: s.app.scope })); expect(result.state).toBe('succeeded'); expect(result.items[0]?.assetEffects?.map((item) => [item.assetId, item.delta])).toEqual([['100', '-50'], ['10', '-100'], ['20', '150']]); expect(numericText(asBillObject((s.sent()[1]!.changelist as WireJson[])[0]!).id, '')).toBe('900');
  });
  it('refuses missing LoanInfo, foreign cash, stale source and unsupported repayment edit before send', async () => {
    const s = await debtSetup(); await s.app.repository((r) => r.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '20', kind: 'asset', raw: { id: 20, type: 1, currency: 'USD', money: '100', status: 0 } }], pageState: null }, 'assets'));
    const foreign = await s.run((c) => c.submit({ action: 'debt.pay', input: { ...s.input, aboutAssetId: '20' }, requestId: 'foreign', scope: s.app.scope })); expect(foreign.error?.code).toBe('DEBT_CASH_ASSET_INVALID');
    const stale = await s.run((c) => c.submit({ action: 'debt.pay', input: { ...s.input, expectedVersion: 'a'.repeat(64) }, requestId: 'stale', scope: s.app.scope })); expect(stale.error?.code).toBe('DRAFT_SOURCE_CHANGED');
    const repayment = { id: '901', type: 9, money: 1, assetid: 100, bookid: 1, userid: s.app.scope.uid, time: 1 }; await s.app.repository((r) => r.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(repayment)], deletes: [], resources: [], pageState: null }));
    const unsupported = await s.run((c) => c.submit({ action: 'debt.editPrincipal', input: { id: '901', expectedVersion: billVersion(repayment), changes: { principal: '2' } }, requestId: 'unsupported', scope: s.app.scope })); expect(unsupported.error?.code).toBe('DEBT_PRINCIPAL_EDIT_ONLY');
    const { loan: _loan, ...missing } = s.debt; await s.app.repository((r) => r.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '100', kind: 'asset', raw: missing }], pageState: null }, 'assets'));
    const bad = await s.run((c) => c.submit({ action: 'debt.pay', input: { ...s.input, expectedVersion: billVersion(missing) }, requestId: 'missing', scope: s.app.scope })); expect(bad.error?.code).toBe('DEBT_LOAN_INFO_MISSING'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('deletes just the principal repayment, keeps the independent interest record and reverses only principal cash', async () => {
    const s = await debtSetup(), principal = { id: '900', type: 9, money: '30', assetid: 100, fromid: 10, bookid: 1, userid: s.app.scope.uid, time: 1, status: 1 }, interest = { ...principal, id: '901', type: 10, money: '5', assetid: 10, fromid: 100 };
    await s.app.repository((r) => r.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(principal), projectBill(interest)], deletes: [], resources: [], pageState: null }));
    const result = await s.run((c) => c.submit({ action: 'ledger.delete', input: { bills: [{ id: '900', expectedVersion: billVersion(principal) }] }, requestId: 'delete-payment', scope: s.app.scope })); expect(result.state).toBe('succeeded'); expect((s.sent()[0]!.dellist as WireJson[]).map((id) => numericText(id, ''))).toEqual(['900']); expect(result.items[0]?.assetEffects?.map((item) => [item.assetId, item.delta])).toEqual([['100', '-30'], ['10', '30']]); await s.app.repository((r) => expect(r.readBill(s.app.scope, '901')).not.toBeNull());
  });
  it('maps lent principal/collection/interest to7,4,11 and cash directions without adding assets to the payload', async () => {
    const s = await debtSetup(), lent = { ...s.debt, stype: 52, money: '100', loan: { ...s.debt.loan, money: '100' } }; await s.app.repository((r) => r.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '100', kind: 'asset', raw: lent }], pageState: null }, 'assets'));
    const { interest: _interest, ...input } = { ...s.input, expectedVersion: billVersion(lent) }; await s.run((c) => c.submit({ action: 'debt.appendPrincipal', input, requestId: 'lend-append', scope: s.app.scope })); const append = asBillObject((s.sent()[0]!.changelist as WireJson[])[0]!); expect([numericText(append.type, ''), numericText(append.assetid, ''), numericText(append.fromid, '')]).toEqual(['7', '100', '10']);
    const paid = await s.run((c) => c.submit({ action: 'debt.pay', input: { ...s.input, expectedVersion: billVersion(lent) }, requestId: 'lend-paid', scope: s.app.scope })); const rows = (s.sent()[1]!.changelist as WireJson[]).map(asBillObject); expect(rows.map((raw) => numericText(raw.type, ''))).toEqual(['4', '11']); expect(numericText(rows[0]!.targetid, '')).toBe('10'); expect(numericText(rows[1]!.fromid, '')).toBe('100'); expect(paid.items.flatMap((item) => item.assetEffects ?? []).filter((item) => item.assetId === '10').map((item) => item.delta)).toEqual(['30', '5']); expect(Object.keys(s.sent()[1]!)).toEqual(['changelist', 'dellist']);
  });
  it('clamps deleted borrowed principal to nonpositive and rolls interest back only through cash assetid', async () => {
    const s = await debtSetup(), debt = { ...s.debt, money: '-20' }, principal = { id: '910', type: 6, money: '50', assetid: 100, targetid: 10, bookid: 1, userid: s.app.scope.uid, time: 1 }, interest = { ...principal, id: '911', type: 10, assetid: 10, fromid: 100, targetid: -1, money: '5' };
    await s.app.repository((r) => { r.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '100', kind: 'asset', raw: debt }], pageState: null }, 'assets'); r.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(principal), projectBill(interest)], deletes: [], resources: [], pageState: null }); });
    const p = await s.run((c) => c.submit({ action: 'ledger.delete', input: { bills: [{ id: '910', expectedVersion: billVersion(principal) }] }, requestId: 'delete-loan', scope: s.app.scope })); expect(p.items[0]?.assetEffects?.map((item) => [item.assetId, item.delta, item.expectedBalance])).toEqual([['100', '20', '0'], ['10', '-50', '950']]);
    const i = await s.run((c) => c.submit({ action: 'ledger.delete', input: { bills: [{ id: '911', expectedVersion: billVersion(interest) }] }, requestId: 'delete-interest', scope: s.app.scope })); expect(i.items[0]?.assetEffects?.map((item) => [item.assetId, item.delta])).toEqual([['10', '5']]);
  });
});
describe('dedicated debt asset creation', () => {
  it('saves only the official initial principal bill from asset.submit and never sends an extra syncall', async () => {
    const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope);
    const childId = '1792000000123100011', newDebt = { id: 1000, userid: app.scope.uid, name: '测试借入', type: 5, stype: 51, money: '-100', currency: 'CNY', status: 0, incount: 1, loan: { accountId: 10, money: '-100', totalpay: '0', startdate: '2026-01-01' } };
    await app.repository(async (repository) => {
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
      for (const domain of ['ledger', 'books', 'assets'] as const) { repository.createDataset(app.scope, domain, domain); repository.applyPage(app.scope, domain, { upserts: [], deletes: [], resources: domain === 'books' ? [{ id: '1', kind: 'book', raw: { bookid: 1, name: 'test' } }] : domain === 'assets' ? [{ id: '10', kind: 'asset', raw: { id: 10, type: 1, stype: 11, money: '1000', currency: 'CNY', name: 'cash', status: 0, incount: 1 } }] : [], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain); repository.switchDataset(app.scope, domain, domain, null); }
      upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: newDebt, bill: parseWire(`{"id":${childId},"bookid":1,"type":6,"money":100,"time":1767196800,"userid":"user-A","assetid":1000,"targetid":10,"status":1}`) } })));
      const handler=createDebtMutationHandler();
      const coordinator = new Coordinator({ repository, client: upstream.client, clock }, new Map([['debt.create', handler],['test.oldCreate',{...handler,prepare:async()=>({payload:{},items:[{id:'old',affectedIds:['asset-catalog']}],affectedIds:['asset-catalog'],affectedDomains:['assets']}),send:async()=>{throw new Error('lost old create');}}]]));
      expect((await coordinator.submit({action:'test.oldCreate',requestId:'old-create',scope:app.scope,input:{}})).state).toBe('uncertain');
      const command = { action: 'debt.create', requestId: 'create-borrow', scope: app.scope, input: { direction: 'borrow', name: '测试借入', principal: '100', bookId: '1', aboutAssetId: '10', startDate: '2026-01-01', inCount: true } };
      const result = await coordinator.submit(command); expect(result.state).toBe('succeeded'); expect((await coordinator.submit(command)).id).toBe(result.id); expect(upstream.calls).toHaveLength(1); expect(upstream.calls[0]!.url).toContain('/asset/submit');
      const form = new URLSearchParams(upstream.calls[0]!.body), extra = asBillObject(parseWire(form.get('extra')!)); expect(moneyText(extra.bookid)).toBe('1'); expect(moneyText(extra.accountId)).toBe('10');
      expect(asBillObject(asBillObject(parseWire(form.get('v')!)).loan).accountId).toBeUndefined();
      expect(repository.sql.exec('SELECT id FROM bills').toArray()).toHaveLength(1); expect(repository.readBill(app.scope, childId)?.type).toBe(6); expect(moneyText(asBillObject(repository.readResources(app.scope, 'asset', { domain: 'assets', ids: ['1000'] }).items[0]!.raw).money)).toBe('-100');
      const cash: WireJson = repository.readResources(app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw; expect(moneyText(asBillObject(cash).money)).toBe('1000'); expect(result.items.flatMap((item) => item.assetEffects ?? [])).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: '10', delta: '100', confirmation: 'expected' })]));
    });
  });
});
describe('debt source cache', () => {
  it('uses t51/status0 listloan once per60seconds, sharing canonical asset IDs and never treating another list as extra balances', async () => {
    const s = await debtSetup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { list: [s.debt] } })));
    await s.app.repository(async (repository) => {
      const service = new DebtService({ repository, client: s.upstream.client, clock: s.clock, cache: new ResourceCache(repository, s.clock), connection: { scope: () => s.app.scope } });
      const first = await service.list({ direction: 'borrow', finished: false }); expect(first.items[0]?.state).toEqual({ direction: 'borrow', balance: '-100', totalPrincipal: '-100', totalPaid: '0' }); expect(first.freshness.complete).toBe(true);
      await service.list({ direction: 'borrow', finished: false }); expect(s.upstream.calls).toHaveLength(1); const form = new URLSearchParams(s.upstream.calls[0]!.body); expect([form.get('t'), form.get('status')]).toEqual(['51', '0']);
      expect(repository.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['100'] }).items).toHaveLength(1); s.clock.advance(60_000); s.upstream.respond(async () => new Response('{"ec":500,"msg":"failure"}')); const offline = await service.list({ direction: 'borrow', finished: false }); expect(offline.items).toHaveLength(1); expect(offline.freshness.stale).toBe(true); expect(offline.problem).toBeTruthy();
    });
  });
  it('keeps missing LoanInfo visible as unavailable accounting instead of manufacturing zero metadata', async () => {
    const s = await debtSetup(), { loan: _loan, ...missing } = s.debt; s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { list: [missing] } })));
    await s.app.repository(async (repository) => { const service = new DebtService({ repository, client: s.upstream.client, clock: s.clock, cache: new ResourceCache(repository, s.clock), connection: { scope: () => s.app.scope } }); const view = await service.list({ direction: 'borrow', finished: false }); expect(view.items[0]).toMatchObject({ state: null, loanInfoMissing: true }); });
  });
});
