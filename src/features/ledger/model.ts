import type { BillRecord } from '../../storage/mirror';
import type { WireJson } from '../../shared/wire-json';
import { asBillObject, billExtra, billLinks, moneyText, numericText, optionalWireId, positiveBillId } from '../../shared/bill-wire';
import { DomainError } from '../../shared/errors';
import type { BillSummary, HistoricalCurrency } from './contract';

function integer(value: WireJson | undefined, fallback = 0): number {
  const text = numericText(value, String(fallback)), number = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(number)) throw new DomainError('BILL_DATA_INVALID', '账单整数资料无法识别');
  return number;
}
function string(value: WireJson | undefined): string | null { return typeof value === 'string' ? value : null; }
function ids(value: WireJson | undefined): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new DomainError('BILL_DATA_INVALID', '账单集合资料无法识别');
  return value.map((item) => optionalWireId(item)!).filter((item) => item !== null);
}
export function summarizeBill(record: BillRecord): BillSummary {
  const raw = asBillObject(record.raw), extra = billExtra(raw), links = billLinks(raw);
  const currencyRaw = extra.curr == null ? null : asBillObject(extra.curr);
  const currency: HistoricalCurrency | null = currencyRaw ? {
    srcSymbol: string(currencyRaw.ss), srcValue: moneyText(currencyRaw.sv), targetSymbol: string(currencyRaw.ts), targetValue: moneyText(currencyRaw.tv), baseSymbol: string(currencyRaw.bs), baseValue: moneyText(currencyRaw.bv),
  } : null;
  const legacyRefundId = positiveBillId(extra.refundid), oldMoney = moneyText(extra.refundv);
  return { id: record.id, bookId: record.bookId, type: record.type, timeSec: record.timeSec, money: record.money,
    remark: string(raw.remark) ?? '', categoryId: optionalWireId(raw.cateid), memberId: optionalWireId(raw.userid),
    assetId: optionalWireId(raw.assetid), fromId: optionalWireId(raw.fromid), targetId: optionalWireId(raw.targetid), tagIds: ids(extra.tags), images: ids(raw.images),
    platform: integer(raw.platform), fromAct: string(raw.fromact), targetAct: string(raw.targetact), description: string(raw.descinfo), packId: optionalWireId(raw.packid),
    flags: integer(extra.flag), transferFee: moneyText(extra.transfee), currency,
    unknownType: ![0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 20, 21].includes(record.type),
    refundIds: links.filter((link) => link.kind === 'refund').map((link) => link.targetId), reimbursementIds: links.filter((link) => link.kind === 'reimbursement').map((link) => link.targetId),
    refundSourceId: positiveBillId(extra.refundsid), reimbursementSourceId: positiveBillId(extra.bxsid),
    legacyRefund: legacyRefundId ? { id: legacyRefundId, money: oldMoney } : null,
    legacyReimbursement: { marked: integer(extra.baoxiaoed) === 1, money: moneyText(extra.baoxiaov, '-1'), timeSec: extra.baoxiaotime == null ? null : integer(extra.baoxiaotime), assetId: optionalWireId(extra.baoxiaoasset) },
  };
}
