import {resourceExisted,billExisted} from '../../operations/identity';
import type { MutationHandler } from '../../operations/contract';
import { asBillObject, moneyText, numericText, positiveBillId } from '../../shared/bill-wire';
import { createDebtSchema } from './contract';
import { createLedgerMutationHandler, restoreBillInput } from '../ledger/write';
import { assetError, validateAsset } from '../assets/model';
import { debtAmount, debtCashDelta } from './accounting';
import { compareMoney, subtractMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import { stringifyWire,parseWire } from '../../shared/wire-json';
import { debtCash, debtEffect, debtState } from './model';
import { projectBill } from '../sync/incremental';
import { ResourceCache } from '../../storage/cache';
import type { OperationContext } from '../../operations/contract';
import { prepareDebtBills } from './bills';
import { assertImageReferences } from '../attachments/references';
export function createDebtBillMutationHandler(dependencies: { baseCurrency?: () => string; reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return createLedgerMutationHandler({ ...dependencies, prepare: (command, ctx) => prepareDebtBills(command, ctx, dependencies.baseCurrency?.() ?? 'CNY').prepared });
}
export function createDebtMutationHandler(dependencies: { baseCurrency?: () => string } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const input = createDebtSchema.parse(restoreBillInput(command.input)), base = dependencies.baseCurrency?.() ?? 'CNY', principal = debtAmount(input.principal), scope = command.scope;
      if (compareMoney(principal, '0') <= 0) return assetError('DEBT_AMOUNT_INVALID', '初始本金必须大于零');
      if (!ctx.repository.dataset(scope, 'ledger')?.complete) return assetError('LEDGER_INCOMPLETE', '请先完成账单同步');
      if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [input.bookId] }).items.length) return assetError('BOOK_NOT_LOADED', '请先载入目标账本');
      const cash = debtCash(ctx, scope, input.aboutAssetId, base), signed = input.direction === 'borrow' ? subtractMoney('0', principal) : principal;
      const raw = { id: -1, userid: scope.uid, type: 5, stype: input.direction === 'borrow' ? 51 : 52, name: input.name, money: new LosslessNumber(signed), status: 0, sort: 0, incount: input.inCount ? 1 : 0, lastPayTime: 0,
        loan: { money: new LosslessNumber(signed), totalpay: 0, startdate: input.startDate, enddate: input.endDate ?? null } };
      // APK puts a Gson JsonArray into Android JSONObject: this field is a JSON string.
      const extra = { bookid: new LosslessNumber(input.bookId), ...(input.aboutAssetId ? { accountId: new LosslessNumber(input.aboutAssetId) } : {}), ...(input.remark ? { remark: input.remark } : {}), ...(input.images?.length ? { images: JSON.stringify(assertImageReferences(ctx, scope, input.images)) } : {}) };
      const logicalId = `debt:${command.requestId}`, affectedIds = [`asset-new:${command.requestId}`, ...(cash ? [`asset:${input.aboutAssetId}`] : [])], effects = cash ? [debtEffect(cash, debtCashDelta(input.direction, 'append', principal), base)] : [];
      return { payload: { scope: { ...scope }, logicalId, raw, extra, base, bookId: input.bookId, principal, direction: input.direction, cashId: input.aboutAssetId ?? null, remark: input.remark ?? '' }, items: [{ id: logicalId, affectedIds, assetEffects: effects }], affectedIds, affectedDomains: ['assets', 'ledger'] };
    },
    send: async (prepared, ctx) => { const p = asBillObject(prepared.payload), scope = asBillObject(p.scope); return ctx.client.request('asset.submit', { uid: String(scope.uid), v: stringifyWire(p.raw!), extra: stringifyWire(p.extra!) }, { uid: String(scope.uid), connectionEpoch: String(scope.connectionEpoch) }); },
    applyReceipt: (prepared, reply, ctx) => {
      const p = asBillObject(prepared.payload), s = asBillObject(p.scope), scope = { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }, data = asBillObject(reply.data), raw = validateAsset(asBillObject(data.asset), scope), id = positiveBillId(raw.id)!, state = debtState(raw, String(p.base)), expected = asBillObject(p.raw);
      if (state.direction !== p.direction || compareMoney(state.balance, moneyText(expected.money)) !== 0 || compareMoney(state.totalPrincipal, moneyText(expected.money)) !== 0 || compareMoney(state.totalPaid, '0') !== 0 || raw.name !== expected.name || numericText(raw.incount, '') !== numericText(expected.incount, '') || numericText(raw.status, '') !== '0') return assetError('DEBT_RECEIPT_INVALID', '新增借贷回执与本金、方向或资料不一致');
      const loan = asBillObject(raw.loan), intended = asBillObject(expected.loan);
      if (loan.startdate !== intended.startdate || numericText(loan.enddate, '') !== numericText(intended.enddate, '') || loan.accountId !== undefined && positiveBillId(loan.accountId) !== (p.cashId ?? null)) return assetError('DEBT_RECEIPT_INVALID', '新增借贷的日期或关联资产不一致');
      if (resourceExisted(prepared,ctx.repository,scope,'assets','asset',id,ctx.validatingHistoricalReceipt)) return assetError('ASSET_NEW_ID_CONFLICT', '新增借贷回执复用了已有资产ID');
      const bill = projectBill(data.bill!), wire = asBillObject(bill.raw), cashField = p.direction === 'borrow' ? 'targetid' : 'fromid';
      if (bill.type !== (p.direction === 'borrow' ? 6 : 7) || positiveBillId(wire.assetid) !== id || positiveBillId(wire[cashField]) !== (p.cashId ?? null) || numericText(wire.bookid, '') !== p.bookId || numericText(wire.userid, '') !== scope.uid || compareMoney(bill.money, String(p.principal)) !== 0 || billExisted(prepared,ctx.repository,scope,bill.id,ctx.validatingHistoricalReceipt) || p.remark && wire.remark !== p.remark) return assetError('DEBT_INITIAL_BILL_INVALID', '官方初始本金账单缺失或与本次借贷不一致');
      const imageField=asBillObject(p.extra).images;
      if(imageField!==undefined){const images=typeof imageField==='string'?parseWire(imageField):imageField;if(!Array.isArray(images)||!images.every(image=>typeof image==='string')||!Array.isArray(wire.images)||stringifyWire(images)!==stringifyWire(wire.images))return assetError('DEBT_INITIAL_BILL_INVALID','官方初始本金账单未保留本次选择的图片');}
      const ledger = ctx.repository.dataset(scope, 'ledger'); if (!ledger) return assetError('DATASET_MISSING', '账单数据集不存在');
      new ResourceCache(ctx.repository, ctx.clock).confirmResources(scope, 'assets', [{ id, kind: 'asset', raw }]);
      ctx.repository.applyPage(scope, ledger.id, { upserts: [bill], deletes: [], resources: [], pageState: ctx.repository.syncState(scope, 'ledger', ledger.id)?.pageState ?? null });
      const affectedIds = [...prepared.affectedIds, `asset:${id}`, bill.id]; return { items: [{ id: String(p.logicalId), state: 'succeeded', affectedIds }], affectedIds, idMap: { [String(p.logicalId)]: id, [`${String(p.logicalId)}:principal`]: bill.id } };
    },
    // A name/amount match cannot identify a lost server-created asset and its initial bill.
    reconcile: async () => ({ items: [] }),
  };
}
