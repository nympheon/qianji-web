import { LosslessNumber } from 'lossless-json';
import type { ExpectedAssetEffect, MutationCommand, OperationContext, PreparedMutation } from '../../operations/contract';
import { asBillObject, billExtra, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { assetError, loadAsset } from '../assets/model';
import { appendPrincipalSchema, debtPaymentSchema, editPrincipalSchema, type DebtPreview } from './contract';
import { billVersion, ensureBillUnrelated, nextBillId, prepareBillEntries, restoreBillInput, type BillMutationEntry } from '../ledger/write';
import { debtAmount, debtCashDelta, paymentState, principalState, splitDebtPayment } from './accounting';
import { debtCash, debtEffect, debtState } from './model';
import { assertImageReferences } from '../attachments/references';
const num = (value: string | null | undefined) => new LosslessNumber(value ?? '-1');
export function debtIds(raw: BillObject) {
  const type = numericText(raw.type, '');
  return { debtId: positiveBillId(['10', '11'].includes(type) ? raw.fromid : raw.assetid), cashId: positiveBillId(['10', '11'].includes(type) ? raw.assetid : ['6', '4'].includes(type) ? raw.targetid : raw.fromid) };
}
export function prepareDebtBills(command: MutationCommand, ctx: Pick<OperationContext, 'repository' | 'clock'>, base = 'CNY'): { prepared: PreparedMutation; preview: DebtPreview } {
  const scope = command.scope, edit = command.action === 'debt.editPrincipal', pay = command.action === 'debt.pay';
  if (!edit && !pay && command.action !== 'debt.appendPrincipal') return assetError('DEBT_ACTION_INVALID', '借贷动作无效');
  const parsed = restoreBillInput(command.input), payment = pay ? debtPaymentSchema.parse(parsed) : null, input = edit ? editPrincipalSchema.parse(parsed) : payment ?? appendPrincipalSchema.parse(parsed);
  if (!ctx.repository.dataset(scope, 'ledger')?.complete) return assetError('LEDGER_INCOMPLETE', '请先完成账单同步');
  const previous = edit ? ctx.repository.readBill(scope, input.id) : null;
  if (edit && !previous) return assetError('BILL_NOT_LOADED', '原本金账单尚未载入');
  if (previous && ![6, 7].includes(previous.type)) return assetError('DEBT_PRINCIPAL_EDIT_ONLY', '只有借入或借出本金记录支持此编辑操作');
  const old = previous ? asBillObject(previous.raw) : null;
  if (old) { ensureBillUnrelated(old); if (numericText(old.userid, '') !== scope.uid) return assetError('BILL_NOT_OWNED', '只能编辑自己创建的本金记录'); if (billExtra(old).curr != null) return assetError('DEBT_CURRENCY_UNSUPPORTED', '历史多币种借贷记录不能由本位币页面改写'); }
  const changes = 'changes' in input ? input.changes : input, priorIds = old ? debtIds(old) : null, debtId = 'debtAssetId' in changes ? changes.debtAssetId ?? priorIds!.debtId : priorIds?.debtId ?? input.id;
  if (!debtId) return assetError('DEBT_ASSET_REQUIRED', '本金记录缺少借贷对象');
  const rawDebt = loadAsset(ctx, scope, debtId), state = debtState(rawDebt, base), versioned = previous ? previous.raw : rawDebt;
  if (billVersion(versioned) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '借贷资料已变化，请重新查看');
  if (numericText(rawDebt.status, '0') !== '0') return assetError('DEBT_FINISHED', '请先将借贷恢复为未结清状态');
  if (old && (previous!.type === 6 ? 'borrow' : 'lend') !== state.direction) return assetError('DEBT_DIRECTION_LOCKED', '编辑本金时不能切换借入与借出方向');
  const bookId = changes.bookId ?? numericText(old?.bookid, ''), cashId = changes.aboutAssetId !== undefined ? changes.aboutAssetId : priorIds?.cashId ?? null, timeSec = changes.timeSec ?? Number(numericText(old?.time, '0'));
  if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [bookId] }).items.length) return assetError('BOOK_NOT_LOADED', '请先载入目标账本');
  const cash = debtCash(ctx, scope, cashId, base), entered = changes.principal ?? previous!.money;
  const split = pay ? splitDebtPayment(state.balance, entered, payment?.interest ?? '0') : { principal: debtAmount(entered), interest: '0', overflow: false };
  if (compareMoney(split.principal, '0') <= 0 && (!pay || compareMoney(split.interest, '0') <= 0)) return assetError('DEBT_AMOUNT_INVALID', pay ? '本金或利息至少一项大于零' : '本金必须大于零');
  if (compareMoney(split.principal, '0') === 0 && changes.images?.length) return assetError('DEBT_INTEREST_IMAGES_UNSUPPORTED', '原生还款图片属于本金记录，纯利息请先移除图片');
  const images = changes.images === undefined ? undefined : assertImageReferences(ctx, scope, changes.images, Array.isArray(old?.images) ? old.images.filter((value): value is string => typeof value === 'string') : []);
  const oldPrincipal = previous?.money ?? '0', sameDebt = priorIds?.debtId === debtId;
  const expectedState = pay ? paymentState(state, split.principal) : principalState(state, split.principal, sameDebt ? oldPrincipal : '0');
  const principalEffects = [debtEffect(rawDebt, subtractMoney(expectedState.balance, state.balance), base)];
  if (old && !sameDebt) {
    const oldDebt = loadAsset(ctx, scope, priorIds!.debtId!), oldState = debtState(oldDebt, base), reverted = principalState(oldState, '0', oldPrincipal);
    principalEffects.push(debtEffect(oldDebt, subtractMoney(reverted.balance, oldState.balance), base));
  }
  if (old && priorIds?.cashId) {
    const oldCash = debtCash(ctx, scope, priorIds.cashId, base)!;
    principalEffects.push(debtEffect(oldCash, subtractMoney('0', debtCashDelta(state.direction, 'append', oldPrincipal)), base));
  }
  if (cash) principalEffects.push(debtEffect(cash, debtCashDelta(state.direction, pay ? 'pay' : 'append', split.principal), base));
  const merged = mergeDebtEffects(principalEffects), used = new Set<string>(), nowSec = Math.floor(ctx.clock.nowMs() / 1000), entries: BillMutationEntry[] = [];
  const build = (type: number, amount: string, previousRaw?: BillObject): BillObject => {
    const id = previousRaw ? numericText(previousRaw.id, '') : nextBillId(ctx, scope, used), interest = type === 10 || type === 11;
    const raw: BillObject = previousRaw ? { ...previousRaw } : { id: num(id), createtime: nowSec, platform: 0, packid: 0, extra: {}, images: [] };
    raw.type = type; raw.money = num(amount); raw.bookid = num(bookId); raw.time = timeSec; raw.userid = scope.uid; raw.status = 2; raw.updatetime = nowSec; raw.cateid = 0;
    raw.assetid = num(interest ? cashId : debtId); raw.fromid = num(interest ? debtId : [7, 9].includes(type) ? cashId : null); raw.targetid = num([6, 4].includes(type) ? cashId : null);
    raw.remark = changes.remark ?? (previousRaw?.remark ?? (interest ? '借贷利息' : '')); raw.descinfo = typeof rawDebt.name === 'string' ? rawDebt.name : '';
    if (!interest && images !== undefined) raw.images = images;
    for (const key of ['category', 'fromact', 'targetact', 'paytype', 'bookname']) delete raw[key]; return raw;
  };
  if (compareMoney(split.principal, '0') > 0) { const type = pay ? state.direction === 'borrow' ? 9 : 4 : state.direction === 'borrow' ? 6 : 7, wire = build(type, split.principal, old ?? undefined); entries.push({ logicalId: numericText(wire.id, ''), mode: edit ? 'edit' : 'create', wire, done: false, assetEffects: merged }); }
  if (compareMoney(split.interest, '0') > 0) { const wire = build(state.direction === 'borrow' ? 10 : 11, split.interest); entries.push({ logicalId: numericText(wire.id, ''), mode: 'create', wire, done: false, assetEffects: cash ? [debtEffect(cash, debtCashDelta(state.direction, 'pay', split.interest), base)] : [] }); }
  const prepared = prepareBillEntries(scope, entries, ctx.clock.nowMs()), effects = mergeDebtEffects(entries.flatMap((entry) => entry.assetEffects ?? []));
  return { prepared: { ...prepared, payload: { ...asBillObject(prepared.payload), debtExpectedState: { ...expectedState }, normalized: { ...split }, debtId } }, preview: { debtId, ...split, expectedState, effects } };
}
export function mergeDebtEffects(effects: ExpectedAssetEffect[]): ExpectedAssetEffect[] {
  const map = new Map<string, ExpectedAssetEffect>();
  for (const effect of effects) { const old = map.get(effect.assetId); if (!old) map.set(effect.assetId, { ...effect }); else { old.delta = addMoney(old.delta, effect.delta); old.expectedBalance = addMoney(old.balanceBefore, old.delta); } }
  return [...map.values()];
}
