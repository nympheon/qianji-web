import { DomainError } from '../../shared/errors';
import type { HistoricalCurrency } from './contract';
import type { ExpectedAssetEffect, TransferAmounts, TransferAsset, TransferMovement, TransferPreview } from './transfer-contract';
import { transferInputSchema } from './transfer-contract';
import type { MutationCommand, MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { asBillObject, billExtra, moneyText, numericText, type BillObject } from '../../shared/bill-wire';
import { billVersion, createLedgerMutationHandler, ensureBillUnrelated, nextBillId, prepareBillEntries, restoreBillInput } from './write';
import { LosslessNumber } from 'lossless-json';
import type { ActorScope } from '../../shared/model';
import { assertImageReferences } from '../attachments/references';

const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
const abs = (money: string) => money.startsWith('-') ? money.slice(1) : money;
const negative = (money: string) => subtractMoney('0', money);
export function transferAmounts(entered: string, fee: string, currency: HistoricalCurrency | null = null): TransferAmounts {
  if (compareMoney(entered, '0') <= 0 || compareMoney(abs(fee), entered) > 0) return fail('TRANSFER_AMOUNT_INVALID', '录入金额必须大于零，费用或优惠不能超过录入金额');
  const principal = subtractMoney(entered, abs(fee));
  if (currency) {
    if (compareMoney(currency.srcValue, entered) !== 0 || [currency.targetValue, currency.baseValue].some((value) => compareMoney(value, '0') < 0)) return fail('TRANSFER_CURRENCY_INVALID', '历史币种金额与录入金额不一致');
    currency = { ...currency };
    if (currency.srcSymbol === currency.targetSymbol) currency.targetValue = compareMoney(fee, '0') > 0 ? subtractMoney(entered, fee) : entered;
  }
  return { principal, fee, fromAmount: compareMoney(fee, '0') > 0 ? addMoney(principal, fee) : principal,
    targetAmount: currency ? currency.targetValue : compareMoney(fee, '0') < 0 ? addMoney(principal, abs(fee)) : principal, currency };
}
function amountsOf(movement: TransferMovement) {
  return { fromAmount: compareMoney(movement.fee, '0') > 0 ? addMoney(movement.principal, movement.fee) : movement.principal,
    targetAmount: movement.currency ? movement.currency.targetValue : compareMoney(movement.fee, '0') < 0 ? addMoney(movement.principal, abs(movement.fee)) : movement.principal };
}
export function transferEffects(next: TransferMovement | null, previous: TransferMovement | null, assets: TransferAsset[]): ExpectedAssetEffect[] {
  const deltas = new Map<string, string>();
  const add = (id: string, delta: string) => deltas.set(id, addMoney(deltas.get(id) ?? '0', delta));
  if (previous) { const old = amountsOf(previous); add(previous.fromAssetId, old.fromAmount); add(previous.targetAssetId, negative(old.targetAmount)); }
  if (next) { const current = amountsOf(next); add(next.fromAssetId, negative(current.fromAmount)); add(next.targetAssetId, current.targetAmount); }
  return [...deltas].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, delta]) => {
    const asset = assets.find((asset) => asset.id === assetId);
    if (!asset) return fail('ASSET_NOT_LOADED', '相关资产尚未完整载入');
    const advance = !previous && next?.type === 3 && next.targetAssetId === assetId && BigInt(next.timeSec) > BigInt(asset.lastPayTimeSec);
    return { assetId, currency: asset.currency, delta, balanceBefore: asset.money, expectedBalance: addMoney(asset.money, delta), confirmation: 'expected', ...(advance ? { expectedLastPayTimeSec: String(next.timeSec) } : {}) };
  });
}
export function loadTransferAsset(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, id: string, baseCurrency = 'CNY'): TransferAsset {
  const resource = ctx.repository.readResources(scope, 'asset', { domain: 'assets', ids: [id] }).items[0];
  if (!resource) return fail('ASSET_NOT_LOADED', '相关资产尚未载入');
  const raw = asBillObject(resource.raw), type = Number(numericText(raw.type, '0'));
  if (!Number.isSafeInteger(type)) return fail('ASSET_DATA_INVALID', '资产类型无效');
  return { id, name: typeof raw.name === 'string' ? raw.name : id, type, currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : baseCurrency,
    money: moneyText(raw.money), lastPayTimeSec: numericText(raw.lastPayTime, '0') };
}
function movementOf(raw: BillObject): TransferMovement {
  const extra = billExtra(raw), curr = extra.curr == null ? null : asBillObject(extra.curr);
  return { fromAssetId: numericText(raw.fromid, ''), targetAssetId: numericText(raw.targetid, ''), principal: moneyText(raw.money), fee: moneyText(extra.transfee), type: Number(numericText(raw.type, '')) as 2 | 3, timeSec: Number(numericText(raw.time, '0')),
    currency: curr ? { srcSymbol: typeof curr.ss === 'string' ? curr.ss : null, srcValue: moneyText(curr.sv), targetSymbol: typeof curr.ts === 'string' ? curr.ts : null, targetValue: moneyText(curr.tv), baseSymbol: typeof curr.bs === 'string' ? curr.bs : null, baseValue: moneyText(curr.bv) } : null };
}
export function prepareTransfer(command: MutationCommand, ctx: Pick<OperationContext, 'repository' | 'clock'>, baseCurrency = 'CNY'): PreparedMutation {
  const input = transferInputSchema.parse(restoreBillInput(command.input)), scope = command.scope;
  if (!ctx.repository.dataset(scope, 'ledger')?.complete) return fail('LEDGER_INCOMPLETE', '请先完成账单同步');
  const old = input.mode === 'create' ? null : ctx.repository.readBill(scope, input.id);
  if (input.mode !== 'create' && !old) return fail('BILL_NOT_LOADED', '账单尚未载入');
  if (old && input.mode !== 'create' && billVersion(old.raw) !== input.expectedVersion) return fail('DRAFT_SOURCE_CHANGED', '云端副本已变化，请保留草稿并重新查看账单');
  if (old && ![2, 3].includes(old.type)) return fail('BILL_TYPE_UNSUPPORTED', '该记录不是转账或信用卡还款');
  const previous = old ? movementOf(asBillObject(old.raw)) : null;
  if (old) ensureBillUnrelated(asBillObject(old.raw));
  const id = old?.id ?? nextBillId(ctx, scope, new Set()), nowSec = Math.floor(ctx.clock.nowMs() / 1000);
  const raw: BillObject = old ? { ...asBillObject(old.raw) } : { id: new LosslessNumber(id), createtime: nowSec, platform: 0, packid: 0, assetid: -1, cateid: 0, remark: '' };
  const changes = input.mode === 'create' ? input : input.mode === 'edit' ? input.changes : null;
  let next: TransferMovement | null = null;
  const loaded = new Map<string, TransferAsset>();
  const asset = (id: string) => { let value = loaded.get(id); if (!value) { value = loadTransferAsset(ctx, scope, id, baseCurrency); loaded.set(id, value); } return value; };
  if (previous) { asset(previous.fromAssetId); asset(previous.targetAssetId); }
  if (changes) {
    const fromAssetId = changes.fromAssetId ?? previous!.fromAssetId, targetAssetId = changes.targetAssetId ?? previous!.targetAssetId;
    if (fromAssetId === targetAssetId) return fail('TRANSFER_SAME_ASSET', '转出和转入资产必须不同');
    const from = asset(fromAssetId), target = asset(targetAssetId);
    if(command.action==='ledger.repayCard'&&target.type!==2)return fail('REPAY_CARD_TARGET_REQUIRED','信用卡还款只能选择信用卡作为转入资产');
    if ([from, target].some((asset) => asset.type === 5 || asset.type === 6)) return fail('DEBT_ASSET_UNSUPPORTED', '借贷或汇总资产不能用于普通转账');
    const bookId = changes.bookId ?? numericText(raw.bookid, '');
    if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [bookId] }).items.length) return fail('BOOK_NOT_LOADED', '请先载入目标账本');
    const financialChange = input.mode === 'create' || ['enteredMoney', 'fee', 'currency', 'fromAssetId', 'targetAssetId'].some((key) => Object.hasOwn(changes, key));
    const fee = changes.fee ?? previous?.fee ?? '0';
    const enteredMoney = changes.enteredMoney ?? previous?.currency?.srcValue ?? addMoney(previous!.principal, abs(previous!.fee));
    const currency = Object.hasOwn(changes, 'currency') ? changes.currency ?? null : previous?.currency ?? null;
    if (financialChange && !currency && (from.currency !== baseCurrency || target.currency !== baseCurrency)) return fail('TRANSFER_CURRENCY_REQUIRED', '请明确提供本次保存的历史币种金额，不使用当前汇率推算');
    if (financialChange && currency && (currency.srcSymbol !== from.currency || currency.targetSymbol !== target.currency || currency.baseSymbol !== baseCurrency)) return fail('TRANSFER_CURRENCY_INVALID', '历史币种必须匹配所选资产和本位币');
    const amounts = financialChange ? transferAmounts(enteredMoney, fee, currency) : { ...previous!, currency };
    const type = command.action === 'ledger.repayCard' ? 3 : 2;
    next = { fromAssetId, targetAssetId, principal: amounts.principal, fee, currency: amounts.currency, type, timeSec: changes.timeSec ?? previous!.timeSec };
    raw.id = new LosslessNumber(id); raw.bookid = new LosslessNumber(bookId); raw.money = new LosslessNumber(next.principal); raw.fromid = new LosslessNumber(fromAssetId); raw.targetid = new LosslessNumber(targetAssetId); raw.type = type; raw.time = next.timeSec; raw.userid = scope.uid; raw.status = 2; raw.updatetime = nowSec; raw.cateid = 0; raw.assetid = -1;
    raw.descinfo = `${from.name}->${target.name}`;
    if (changes.remark !== undefined) raw.remark = changes.remark;
    if (changes.images !== undefined) raw.images = assertImageReferences(ctx, scope, changes.images, Array.isArray(raw.images) ? raw.images.filter((value): value is string => typeof value === 'string') : []);
    const extra: BillObject = { ...billExtra(raw), transfee: new LosslessNumber(fee) };
    let flag = BigInt(numericText(extra.flag, '0'));
    if (changes.countInStatistics !== undefined) flag = changes.countInStatistics ? flag & ~1n : flag | 1n;
    if (changes.countInBudget !== undefined) flag = changes.countInBudget ? flag & ~2n : flag | 2n;
    extra.flag = new LosslessNumber(String(flag));
    if (changes.tagIds !== undefined) {
      if (changes.tagIds.some((tagId) => !ctx.repository.readResources(scope, 'tag', { domain: 'tags', ids: [tagId] }).items.length)) return fail('TAG_NOT_LOADED', '所选标签尚未载入');
      extra.tags = [...new Set(changes.tagIds)];
    }
    if (amounts.currency) { const c = amounts.currency; extra.curr = { ss: c.srcSymbol, sv: new LosslessNumber(c.srcValue), ts: c.targetSymbol, tv: new LosslessNumber(c.targetValue), bs: c.baseSymbol, bv: new LosslessNumber(c.baseValue) }; }
    else if (financialChange) delete extra.curr;
    raw.extra = extra;
    for (const key of ['category', 'fromact', 'targetact', 'paytype', 'bookname']) delete raw[key];
  }
  const effects = transferEffects(next, previous, [...loaded.values()]);
  return prepareBillEntries(scope, [{ logicalId: id, mode: input.mode, wire: raw, done: false, assetEffects: effects }], ctx.clock.nowMs());
}
export function createTransferMutationHandler(dependencies: { baseCurrency?: () => string; reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return createLedgerMutationHandler({ ...dependencies, prepare: (command, ctx) => prepareTransfer(command, ctx, dependencies.baseCurrency?.() ?? 'CNY') });
}
export function previewTransfer(command: MutationCommand, ctx: Pick<OperationContext, 'repository' | 'clock'>, baseCurrency = 'CNY'): Omit<TransferPreview, 'complete' | 'stale' | 'freshness'> {
  const prepared = prepareTransfer(command, ctx, baseCurrency), payload = asBillObject(prepared.payload), entry = asBillObject((payload.entries as import('../../shared/wire-json').WireJson[])[0]!);
  const movement = movementOf(asBillObject(entry.wire)), amounts = amountsOf(movement);
  return { principal: movement.principal, fee: movement.fee, currency: movement.currency, ...amounts,
    from: loadTransferAsset(ctx, command.scope, movement.fromAssetId, baseCurrency), target: loadTransferAsset(ctx, command.scope, movement.targetAssetId, baseCurrency), effects: prepared.items[0]?.assetEffects ?? [] };
}
