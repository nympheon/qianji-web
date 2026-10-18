import { isLosslessNumber } from 'lossless-json';
import { DomainError } from './errors';
import { parseWire, wireId, type WireJson } from './wire-json';
import type { Money } from './model';

export type BillObject = { [key: string]: WireJson | undefined };
export function asBillObject(value: WireJson | undefined): BillObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value)) throw new DomainError('BILL_DATA_INVALID', '账单资料结构无法识别');
  return value;
}
export function billExtra(raw: BillObject): BillObject {
  const value = typeof raw.extra === 'string' ? parseWire(raw.extra) : raw.extra;
  return value == null ? {} : asBillObject(value);
}
export function numericText(value: WireJson | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (isLosslessNumber(value)) return value.value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new DomainError('BILL_DATA_INVALID', '账单数值无法识别');
}
export function moneyText(value: WireJson | undefined, fallback: Money = '0'): Money {
  const text = numericText(value, fallback);
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new DomainError('BILL_MONEY_UNSUPPORTED', '账单金额编码需要核验');
  return text;
}
export function positiveBillId(value: WireJson | undefined): string | null {
  const text = numericText(value, '-1');
  return /^\d+$/.test(text) && BigInt(text) > 0n ? text : null;
}
export function billLinks(raw: BillObject): { kind: string; targetId: string; raw: WireJson }[] {
  const extra = billExtra(raw), result: { kind: string; targetId: string; raw: WireJson }[] = [];
  const refunds = extra.rfds == null ? {} : asBillObject(extra.rfds);
  if (Object.keys(refunds).length) {
    for (const [targetId, value] of Object.entries(refunds)) result.push({ kind: 'refund', targetId, raw: value ?? null });
  } else {
    const legacy = positiveBillId(extra.refundid);
    if (legacy && !moneyText(extra.refundv).startsWith('-') && /[1-9]/.test(moneyText(extra.refundv))) result.push({ kind: 'refund', targetId: legacy, raw: extra.refundid! });
  }
  const reimbursements = extra.bxs == null ? {} : asBillObject(extra.bxs);
  for (const [targetId, value] of Object.entries(reimbursements)) result.push({ kind: 'reimbursement', targetId, raw: value ?? null });
  for (const [field, kind] of [['refundsid', 'refund-source'], ['bxsid', 'reimbursement-source']] as const) {
    const targetId = positiveBillId(extra[field]);
    if (targetId) result.push({ kind, targetId, raw: extra[field]! });
  }
  return result;
}
export function optionalWireId(value: WireJson | undefined): string | null { return value == null ? null : wireId(value); }
