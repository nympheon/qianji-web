import { Decimal } from 'decimal.js';
import { addMoney, compareMoney, divideMoney, multiplyMoney, roundMoney, subtractMoney } from '../../shared/numbers';
import { DomainError } from '../../shared/errors';
import { businessTimeSec as repeatTimeSec } from '../../shared/local-time';
import { installmentPreviewSchema, type RemainderMode, type InstallmentPreviewInput, type InstallmentPreview } from './contract';
const Exact = Decimal.clone({ precision: 100 });
export function installmentParts(total: string, count: number, mode: RemainderMode): { average: string; residual: string } {
  if (!Number.isSafeInteger(count) || count <= 0) throw new DomainError('INSTALLMENT_COUNT_INVALID', '分期期数必须大于零'); const divided = divideMoney(total, String(count)), rounded = roundMoney(divided, 2); let average: string;
  if (compareMoney(multiplyMoney(rounded, String(count)), total) === 0) average = divided;
  else if (mode === 'rnd' || mode === 'rndf') average = rounded;
  else if (mode === 'intf' || mode === 'intl') average = new Exact(divided).floor().toFixed();
  else average = new Exact(divided).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed();
  return { average, residual: subtractMoney(total, multiplyMoney(average, String(count - 1))) };
}
function date(value: string) { const result = new Date(value + 'T00:00:00Z'); if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new DomainError('INSTALLMENT_DATE_INVALID', '分期日期无效'); return result; }
/** xf/f0.X0 uses Calendar.set(MONTH,current-1), including its lenient rollover. */
export function installmentInitialCount(first: string, today: string, totalCount: number, zone = 'Asia/Shanghai'): number {
  const start = date(first), now = date(today); if (repeatTimeSec(first, '00:00', zone) <= 0 || now < start) return 0; let count = 0;
  while (now > start) { count++; if (totalCount > 0 && count >= totalCount) return totalCount; now.setUTCMonth(now.getUTCMonth() - 1); if (count > 120000) throw new DomainError('INSTALLMENT_DATE_LIMIT', '分期日期超出计数范围'); } return count;
}
export function previewInstallment(input: InstallmentPreviewInput, today: string): InstallmentPreview {
  const fields = installmentPreviewSchema.parse(input); if (compareMoney(fields.totalMoney, '0') <= 0 || compareMoney(fields.totalFee, '0') < 0) throw new DomainError('INSTALLMENT_AMOUNT_INVALID', '分期本金必须大于零，手续费不能为负数');
  const principal = installmentParts(fields.totalMoney, fields.totalCount, fields.remainder), fees = installmentParts(fields.totalFee, fields.totalCount, fields.remainder), first = date(fields.firstDate), initialCount = installmentInitialCount(fields.firstDate, today, fields.totalCount, fields.zone), firstResidual = ['first', 'rndf', 'intf'].includes(fields.remainder), warnings = new Set<string>(), rows: InstallmentPreview['rows'] = [];
  if (compareMoney(principal.residual, '0') < 0 || fields.feePlacement === 'ave' && compareMoney(fees.residual, '0') < 0) warnings.add('NEGATIVE_NATIVE_REMAINDER');
  for (let index = 0; index < Math.min(fields.totalCount, fields.limit); index++) {
    const value = new Date(0); value.setUTCFullYear(first.getUTCFullYear(), first.getUTCMonth() + index, first.getUTCDate()); value.setUTCHours(0, 0, 0, 0); if (value.getUTCFullYear() > 9999) throw new DomainError('INSTALLMENT_DATE_LIMIT', '分期预览超出日期范围'); const day = value.toISOString().slice(0, 10), residualHere = firstResidual ? index === 0 : index === fields.totalCount - 1;
    const money = residualHere ? principal.residual : principal.average, fee = fields.feePlacement === 'first' ? index === 0 ? fields.totalFee : '0' : fields.feePlacement === 'last' ? index === fields.totalCount - 1 ? fields.totalFee : '0' : residualHere ? fees.residual : fees.average;
    rows.push({ period: index + 1, date: day, timeSec: repeatTimeSec(day, fields.time, fields.zone), principal: money, fee, money: addMoney(money, fee), coveredByInitialCount: index < initialCount });
  }
  return { rows, initialCount, complete: fields.totalCount <= fields.limit, warnings: [...warnings], totals: { principal: fields.totalMoney, fee: fields.totalFee, money: addMoney(fields.totalMoney, fields.totalFee) }, currency: null };
}
