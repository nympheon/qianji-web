import type { BillDetail, BillSummary } from './contract';
import type { Id, Money } from '../../shared/model';
import { addMoney, compareMoney, divideMoney, multiplyMoney, roundMoney, subtractMoney } from '../../shared/numbers';

export const STAT_SLOTS = ['spend', 'income', 'bxValue', 'bxValueOriginal', 'notBxedValue', 'hasBxedValue', 'bxSpend', 'bxIncome', 'transfer', 'creditHuankuan', 'refundValue', 'edBaoxiaoValue', 'transferFee', 'coupon', 'refundSpend', 'refundIncome', 'totalFlagBudget', 'totalFlagCount', 'interestSpend', 'interestIncome'] as const;
export type StatSlots = Record<typeof STAT_SLOTS[number], Money>;
export interface StatItem extends StatSlots { billId: Id; type: number; imageCount: number; currencyProven: boolean; incompleteReasons: string[]; warnings: string[] }
export interface StatSummary extends StatSlots { count: number; imageCount: number; totalSpend: Money; totalIncome: Money; balance: Money; incompleteReasons: string[]; warnings: string[] }
function emptySlots(): StatSlots { return Object.fromEntries(STAT_SLOTS.map((slot) => [slot, '0'])) as StatSlots; }
const positive = (money: Money) => compareMoney(money, '0') > 0;
const absolute = (money: Money) => compareMoney(money, '0') < 0 ? subtractMoney('0', money) : money;
function historicalMoney(bill: BillSummary, currency: Id, baseCurrency: Id, reasons: Set<string>): { money: Money; proven: boolean } {
  const extra = bill.currency;
  if (!extra) {
    if (currency !== baseCurrency) reasons.add('CURRENCY_NOT_RECORDED');
    return { money: bill.money, proven: currency === baseCurrency };
  }
  if (currency === extra.srcSymbol) return { money: compareMoney(bill.transferFee, '0') < 0 ? addMoney(extra.srcValue, bill.transferFee) : subtractMoney(extra.srcValue, bill.transferFee), proven: true };
  if (currency === extra.targetSymbol) return { money: extra.targetValue, proven: true };
  if (currency === extra.baseSymbol) return { money: extra.baseValue, proven: true };
  reasons.add('CURRENCY_NOT_RECORDED');
  return { money: bill.money, proven: false };
}
function historicalFee(bill: BillSummary, mode: 'statistics' | 'budget', currency: Id): Money {
  const extra = bill.currency;
  // APK budgets explicitly pass currency=null; only the monetary value uses the base currency.
  return mode !== 'budget' && bill.transferFee !== '0' && extra && currency !== extra.srcSymbol && extra.baseSymbol && positive(extra.baseValue) && positive(extra.srcValue)
    ? multiplyMoney(bill.transferFee, divideMoney(extra.baseValue, extra.srcValue)) : bill.transferFee;
}
export function toStatItem(bill: BillDetail, mode: 'statistics' | 'budget', currency: Id, baseCurrency: Id = 'CNY'): StatItem {
  const reasons = new Set(bill.incompleteReasons), warnings = new Set<string>();
  if (bill.unknownType) reasons.add('UNKNOWN_BILL_TYPE');
  if (bill.missingRelatedIds.length) reasons.add('RELATED_BILL_MISSING');
  const value = historicalMoney(bill, currency, baseCurrency, reasons);
  const childMoney = (child: BillSummary) => {
    const converted = historicalMoney(child, currency, baseCurrency, reasons);
    // Missing currency metadata cannot prove an arbitrary foreign-currency cross-period sum.
    if (value.proven && !converted.proven) reasons.add('CURRENCY_NOT_RECORDED');
    return converted.money;
  };
  const money = value.money, refund = addMoney(...bill.refunds.map(childMoney)), fee = historicalFee(bill, mode, currency);
  const allowed = (bill.flags & (mode === 'budget' ? 2 : 1)) === 0;
  const item: StatItem = { ...emptySlots(), billId: bill.id, type: bill.type, imageCount: bill.images.length, currencyProven: value.proven, incompleteReasons: [], warnings: [] };
  let flagBase: Money = '0';
  if (positive(refund) && compareMoney(refund, money) > 0) warnings.add('REFUND_EXCEEDS_SOURCE');
  if (bill.type === 0 || bill.type === 10) {
    const net = positive(refund) ? subtractMoney(money, refund) : money;
    if (positive(refund) && !positive(net)) item.refundIncome = absolute(net);
    else { if (allowed) item.spend = net; flagBase = net; }
    if (bill.type === 10) item.interestSpend = item.spend;
  } else if (bill.type === 1 || bill.type === 11) {
    const net = positive(refund) ? subtractMoney(money, refund) : money;
    if (allowed) {
      if (positive(refund) && !positive(net)) item.refundSpend = absolute(net);
      else item.income = net;
    }
    flagBase = money;
    if (bill.type === 11) item.interestIncome = item.income;
  } else if (bill.type === 5) {
    let residual = positive(refund) ? subtractMoney(money, refund) : money;
    if (positive(refund) && !positive(residual)) { if (allowed) item.refundIncome = absolute(residual); residual = '0'; }
    item.bxValue = residual; item.bxValueOriginal = money;
    if (bill.reimbursementIds.length || bill.legacyReimbursement.marked) {
      // Old baoxiaoed is a compatibility marker, not a fabricated V2 child amount.
      item.hasBxedValue = bill.reimbursementIds.length ? addMoney(...bill.reimbursements.map(childMoney)) : '0';
      if (!bill.reimbursementIds.length && bill.legacyReimbursement.marked) warnings.add('LEGACY_REIMBURSEMENT');
      const net = subtractMoney(residual, item.hasBxedValue);
      flagBase = absolute(net);
      if (allowed) { if (positive(net)) item.bxSpend = net; else item.bxIncome = absolute(net); }
      if (compareMoney(net, '0') < 0) warnings.add('REIMBURSEMENT_EXCEEDS_SOURCE');
    } else item.notBxedValue = residual;
  } else if (bill.type === 2) item.transfer = money;
  else if (bill.type === 3) item.creditHuankuan = money;
  else if (bill.type === 20) item.refundValue = money;
  else if (bill.type === 21) item.edBaoxiaoValue = money;
  if (allowed) { if (positive(fee)) item.transferFee = fee; else if (compareMoney(fee, '0') < 0) item.coupon = absolute(fee); }
  if (bill.flags & 1) item.totalFlagCount = flagBase;
  if (bill.flags & 2) item.totalFlagBudget = flagBase;
  if (warnings.has('REFUND_EXCEEDS_SOURCE') && (bill.flags & 1)) warnings.add('EXCLUDED_OVERREFUND_APK_ASYMMETRY');
  item.incompleteReasons = [...reasons]; item.warnings = [...warnings];
  return item;
}
export function aggregate(items: Iterable<StatItem>): StatSummary {
  const result: StatSummary = { ...emptySlots(), count: 0, imageCount: 0, totalSpend: '0', totalIncome: '0', balance: '0', incompleteReasons: [], warnings: [] };
  const reasons = new Set<string>(), warnings = new Set<string>();
  for (const item of items) {
    for (const slot of STAT_SLOTS) result[slot] = addMoney(result[slot], item[slot]);
    result.count++; result.imageCount += item.imageCount;
    item.incompleteReasons.forEach((reason) => reasons.add(reason)); item.warnings.forEach((warning) => warnings.add(warning));
  }
  // Interest is already in spend/income in the APK fromBill -> copyFromBillStatItem path.
  // The dedicated interest slots are explanatory subsets, not another addition.
  result.totalSpend = addMoney(result.spend, result.bxSpend, result.transferFee, result.refundSpend);
  result.totalIncome = addMoney(result.income, result.bxIncome, result.refundIncome);
  result.balance = roundMoney(subtractMoney(result.totalIncome, result.totalSpend), 2);
  result.incompleteReasons = [...reasons]; result.warnings = [...warnings];
  return result;
}
