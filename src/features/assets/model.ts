import type { OperationContext } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { DomainError } from '../../shared/errors';
import { billVersion } from '../ledger/write';
import type { AssetView } from './contract';
import { nativeInstallmentMoney } from './summary';
import { compareMoney, subtractMoney } from '../../shared/numbers';
export const assetError = (code: string, message: string): never => { throw new DomainError(code, message); };
export function validateAsset(raw: BillObject, scope: ActorScope, id?: string): BillObject {
  const actual = positiveBillId(raw.id);
  if (!actual || id && actual !== id || raw.money == null || raw.type == null || raw.status == null || raw.userid !== undefined && numericText(raw.userid, '') !== scope.uid) return assetError('ASSET_RECEIPT_INVALID', '资产回执的ID、所属用户或必要字段无法核对');
  moneyText(raw.money); return raw;
}
export function loadAsset(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, id: string): BillObject {
  const row = ctx.repository.readResources(scope, 'asset', { domain: 'assets', ids: [id] }).items[0];
  if (!row) return assetError('ASSET_NOT_LOADED', '资产资料尚未载入'); return asBillObject(row.raw);
}
export function assetView(raw: BillObject, baseCurrency = 'CNY'): AssetView {
  const type = Number(numericText(raw.type, '-1')), status = Number(numericText(raw.status, '0'));
  const installment = nativeInstallmentMoney(raw), credit = raw.credit == null ? null : asBillObject(raw.credit), statement = credit ? Number(numericText(credit.statedate, '0')) : 0;
  return { id: numericText(raw.id, ''), name: typeof raw.name === 'string' ? raw.name : '', type, subtype: Number(numericText(raw.stype, '-1')), currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : baseCurrency, money: moneyText(raw.money), status,
    visible: status !== 2, finished: status === 1, inCount: numericText(raw.incount, '0') === '1', groupId: typeof raw.groupid === 'string' && raw.groupid ? raw.groupid : null, remark: typeof raw.remark === 'string' ? raw.remark : '', editVersion: billVersion(raw), knownType: [1, 2, 3, 4, 5, 6].includes(type), installmentMoney: installment.money, enteredBalance: compareMoney(installment.money, '0') > 0 ? subtractMoney(moneyText(raw.money), installment.money) : moneyText(raw.money),
    ...(credit ? { credit: { statementDay: statement >= 1 && statement <= 31 ? statement : null, paymentRule: typeof credit.paydate2 === 'string' && credit.paydate2 ? credit.paydate2 : Number(numericText(credit.paydate, '0')) > 0 ? numericText(credit.paydate, '') : null, limit: moneyText(credit.limit), statementIncludesPrevious: numericText(credit.statein, '0') === '1', sharedLimitAssetId: positiveBillId(credit.shareid) } } : {}) };
}
