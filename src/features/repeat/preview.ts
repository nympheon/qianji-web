import { DomainError } from '../../shared/errors';
import { compareMoney, subtractMoney } from '../../shared/numbers';
import { transferAmounts } from '../ledger/transfer';
import { repeatPreviewSchema, type HolidayYears, type PreviewBill, type RepeatFields, type RepeatPreviewInput } from './contract';
const dateText = (date: Date) => date.toISOString().slice(0, 10);
function calendar(year: number, month: number, date: number) { const value = new Date(0); value.setUTCFullYear(year, month, date); value.setUTCHours(0, 0, 0, 0); if (value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999) throw new DomainError('PREVIEW_DATE_LIMIT', '预览日期超出支持范围'); return value; }
function day(value: string) { const date = new Date(value + 'T00:00:00Z'); if (!Number.isFinite(date.getTime()) || dateText(date) !== value) throw new DomainError('INVALID_DATE', '周期业务日期无效'); return date; }
function add(date: Date, count: number) { const next = new Date(date); next.setUTCDate(next.getUTCDate() + count); if (next.getUTCFullYear() > 9999) throw new DomainError('PREVIEW_DATE_LIMIT', '预览日期超出支持范围'); return next; }
export function repeatAmounts(fields: Pick<RepeatFields, 'type' | 'enteredMoney' | 'fee' | 'currency'>) {
  if ([2, 3].includes(fields.type)) { const value = transferAmounts(fields.enteredMoney, fields.fee, fields.currency); return { money: value.principal, fee: value.fee, currency: value.currency }; }
  if (compareMoney(fields.enteredMoney, '0') <= 0 || compareMoney(fields.fee, '0') > 0 || fields.type === 1 && compareMoney(fields.fee, '0') !== 0) throw new DomainError('REPEAT_AMOUNT_INVALID', '普通周期支出仅支持负数优惠，收入不支持费用，金额必须大于零');
  const discount = fields.fee.startsWith('-') ? fields.fee.slice(1) : fields.fee;
  if (compareMoney(discount, fields.enteredMoney) > 0) throw new DomainError('REPEAT_AMOUNT_INVALID', '优惠不能大于录入金额'); return { money: subtractMoney(fields.enteredMoney, discount), fee: fields.fee, currency: fields.currency };
}
/** Reject DST folds/gaps instead of silently selecting a different bill time. */
export function repeatTimeSec(date: string, time: string, zone: string) {
  let format: Intl.DateTimeFormat; try { format = new Intl.DateTimeFormat('en-GB-u-ca-iso8601', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch { throw new DomainError('INVALID_TIMEZONE', '业务时区无效'); }
  const target = Date.parse(`${date}T${time}:00Z`), observed = (ms: number) => { const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value])); return Date.parse(`${p.year!.padStart(4, '0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); }; let instant = target;
  for (let i = 0; i < 5; i++) { const next = instant + target - observed(instant); if (next === instant) break; instant = next; }
  if (observed(instant) !== target) throw new DomainError('LOCAL_TIME_UNAVAILABLE', '该日期的本地时间不存在，请选择其他时间');
  for (const minutes of [-120, -90, -60, -30, 30, 60, 90, 120]) if (observed(instant + minutes * 60000) === target) throw new DomainError('LOCAL_TIME_AMBIGUOUS', '该日期的本地时间因夏令时出现两次，请选择其他时间'); return instant / 1000;
}
function nextDate(anchor: Date, fields: RepeatFields, first: boolean, years: HolidayYears): Date {
  const { type, values } = fields.repeat;
  if (type === 'day' || type === 'bystep') return first ? anchor : add(anchor, type === 'day' ? 1 : Number(values[0]));
  if (type === 'week') { const weekday = anchor.getUTCDay() || 7, distance = Math.min(...values.map((value) => (Number(value) - weekday + 7) % 7 || 7)); return add(anchor, distance); }
  if (type === 'workday') {
    let next = add(anchor, 1); for (let i = 0; i < 370; i++, next = add(next, 1)) { const map = years[String(next.getUTCFullYear())]; if (!map || !Object.keys(map).length) throw new DomainError('HOLIDAYS_MISSING', `缺少${next.getUTCFullYear()}年官方节假日数据，不能按普通工作周估算`); const override = map[dateText(next)]; if (override ? !override.holiday : ![0, 6].includes(next.getUTCDay())) return next; } throw new DomainError('HOLIDAYS_MISSING', '原生查找范围内没有可核对的法定工作日');
  }
  if (type === 'year') {
    // Keep each selected pair intact. Native m() independently takes month/day minima.
    const year = anchor.getUTCFullYear();
    const candidates = [year, year + 1].filter((value) => value <= 9999).flatMap((candidateYear) => values.map((value) => { const [m, d] = value.split('-').map(Number); return calendar(candidateYear, m! - 1, d!); })).filter((value) => value > anchor).sort((a, b) => a.getTime() - b.getTime());
    if (!candidates[0] || candidates[0].getUTCFullYear() > 9999) throw new DomainError('PREVIEW_DATE_LIMIT', '年度预览超出日期范围'); return candidates[0];
  }
  for (let offset = 0; offset < 24; offset++) { const month = calendar(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, 1), last = month.getUTCMonth() === 11 && month.getUTCFullYear() === 9999 ? 31 : calendar(month.getUTCFullYear(), month.getUTCMonth() + 1, 0).getUTCDate(); const candidates = values.map(Number).map((value) => value === 32 ? last : value === 291 ? Math.min(29, last) : value === 301 ? Math.min(30, last) : value <= last ? value : -1).filter((value) => value > 0 && (offset > 0 || first ? value >= (offset ? 1 : anchor.getUTCDate()) : value > anchor.getUTCDate())).sort((a, b) => a - b); if (candidates[0]) { month.setUTCDate(candidates[0]); return month; } }
  throw new DomainError('PREVIEW_DATE_LIMIT', '预览范围内没有有效周期日期');
}
export function previewRepeat(input: RepeatPreviewInput, years: HolidayYears = {}): PreviewBill[] {
  const { fields, limit, zone } = repeatPreviewSchema.parse(input), amounts = repeatAmounts(fields), rows: PreviewBill[] = []; let anchor = day(fields.startDate);
  for (let index = 0; index < Math.min(limit, fields.end?.kind === 'count' ? fields.end.count : limit); index++) { const next = nextDate(anchor, fields, index === 0, years), date = dateText(next); if (fields.end?.kind === 'date' && date >= fields.end.date) break; rows.push({ date, timeSec: repeatTimeSec(date, fields.time, zone), type: fields.type, money: amounts.money, fee: amounts.fee, remark: fields.remark }); anchor = next; } return rows;
}
