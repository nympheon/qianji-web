import type { WireJson } from '../../src/shared/wire-json';
import { expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { ResourceCache } from '../../src/storage/cache';
import { asBillObject } from '../../src/shared/bill-wire';
import { projectBill } from '../../src/features/sync/incremental';
import { billVersion } from '../../src/features/ledger/write';
import { prepareTransfer } from '../../src/features/ledger/transfer';
import { createRefundMutationHandler } from '../../src/features/ledger/refund';
import { createReimbursementMutationHandler } from '../../src/features/ledger/reimbursement';
import { prepareBalance } from '../../src/features/assets/balance';
import { prepareDebtBills } from '../../src/features/debt/bills';
import { createDebtMutationHandler } from '../../src/features/debt/use-cases';

it('associates confirmed bill images using each native business payload and keeps interest images separate', async () => {
  const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope), key = '_confirmed', cash = { id: '10', userid: app.scope.uid, type: 1, stype: 11, currency: 'CNY', money: '100', status: 0, name: 'test' }, debt = { id: '30', userid: app.scope.uid, type: 5, stype: 51, currency: 'CNY', money: '-100', status: 0, name: 'test', loan: { money: '-100', totalpay: '0' } }, source = { id: '100', userid: app.scope.uid, bookid: '1', type: 0, cateid: '1', money: '20', time: 100, extra: {} }, bx = { ...source, id: '101', type: 5 };
  await app.repository(async (repository) => {
    for (const domain of ['ledger', 'assets', 'books'] as const) { repository.createDataset(app.scope, domain, domain); repository.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? [source, bx].map(projectBill) : [], deletes: [], resources: domain === 'assets' ? [cash, { ...cash, id: '20' }, debt].map((raw) => ({ id: raw.id, kind: 'asset' as const, raw })) : domain === 'books' ? [{ id: '1', kind: 'book' as const, raw: { bookid: '1' } }] : [{ id: '1', kind: 'category' as const, raw: { id: '1', bookid: '1' } }], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain); repository.switchDataset(app.scope, domain, domain, null); }
    new ResourceCache(repository, clock).confirmResources(app.scope, 'attachments', [{ id: key, kind: 'attachment', raw: { key, purpose: 'bill', proof: 'qiniu-receipt' } }]);
    const ctx = { repository, clock, client: upstream.client }, command = (action: string, input: WireJson) => ({ action, requestId: action, scope: app.scope, input }), images = [key];
    const transfer = prepareTransfer(command('ledger.transfer', { mode: 'create', bookId: '1', fromAssetId: '10', targetAssetId: '20', enteredMoney: '5', fee: '0', timeSec: 200, images }), ctx);
    expect(asBillObject(asBillObject((asBillObject(transfer.payload).entries as WireJson[])[0]).wire).images).toEqual(images);
    const refund = await createRefundMutationHandler().prepare(command('ledger.refund', { billId: '100', expectedVersion: billVersion(source), money: '5', assetId: '10', timeSec: 200, images }), ctx);
    expect(asBillObject(asBillObject(refund.payload).wire).images).toEqual(images);
    const reimburse = await createReimbursementMutationHandler().prepare(command('ledger.reimburse', { bills: [{ id: '101', expectedVersion: billVersion(bx) }], assetId: '10', money: '5', timeSec: 200, images }), ctx);
    expect(asBillObject(asBillObject(reimburse.payload).wire).images).toBe(JSON.stringify(images));
    const balance = prepareBalance(command('assets.adjustBalance', { id: '10', expectedVersion: billVersion(cash), money: '90', recordDifference: true, difference: { categoryId: '1', countInStatistics: true, countInBudget: true, images } }), ctx);
    expect(asBillObject(balance.params.diffparams).images).toEqual(images);
    const payment = prepareDebtBills(command('debt.pay', { id: '30', expectedVersion: billVersion(debt), bookId: '1', aboutAssetId: '10', principal: '5', interest: '1', timeSec: 200, images }), ctx).prepared, entries = asBillObject(payment.payload).entries as WireJson[];
    expect(asBillObject(asBillObject(entries[0]).wire).images).toEqual(images); expect(asBillObject(asBillObject(entries[1]).wire).images).toEqual([]);
    const create = await createDebtMutationHandler().prepare(command('debt.create', { direction: 'borrow', name: 'test', principal: '5', bookId: '1', aboutAssetId: '10', startDate: '2026-01-01', inCount: true, images }), ctx);
    expect(asBillObject(asBillObject(create.payload).extra).images).toEqual(images);
    expect(() => prepareTransfer(command('ledger.transfer', { mode: 'create', bookId: '1', fromAssetId: '10', targetAssetId: '20', enteredMoney: '5', fee: '0', timeSec: 200, images: ['https://example.test/fake.jpg'] }), ctx)).toThrowError(expect.objectContaining({ code: 'IMAGE_UPLOAD_REQUIRED' }));
  });
});
