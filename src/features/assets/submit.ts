import type { MutationCommand, OperationContext } from '../../operations/contract';
import { asBillObject, moneyText, numericText, type BillObject } from '../../shared/bill-wire';
import { LosslessNumber } from 'lossless-json';
import { billVersion, restoreBillInput } from '../ledger/write';
import { assetSubmitSchema } from './contract';
import { assetError, loadAsset } from './model';
import { compareMoney } from '../../shared/numbers';
export function prepareAssetSubmit(command: MutationCommand, ctx: OperationContext) {
  const input = assetSubmitSchema.parse(restoreBillInput(command.input)), create = input.mode === 'create';
  const fields = input.mode === 'create' ? input.fields : input.changes;
  const raw: BillObject = create ? { id: -1, userid: command.scope.uid, status: 0, sort: 0, incount: 1, money: 0, lastPayTime: 0 } : { ...loadAsset(ctx, command.scope, input.id) };
  if (input.mode === 'edit' && billVersion(raw) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '资产资料已变化，请重新查看');
  if (numericText(raw.type, '-1') === '6') return assetError('ASSET_WRAPPER_UNSUPPORTED', '汇总包装项不能当成真实资产编辑');
  if (input.mode === 'create') { raw.type = input.fields.type; raw.stype = input.fields.subtype; raw.money = new LosslessNumber(input.fields.money); raw.currency = input.fields.currency; }
  if (fields.name !== undefined) raw.name = fields.name;
  if (fields.remark !== undefined) raw.remark = fields.remark;
  if (fields.inCount !== undefined) raw.incount = fields.inCount ? 1 : 0;
  if (fields.icon !== undefined) raw.icon = fields.icon;
  if (fields.color !== undefined) raw.color = fields.color;
  const type = numericText(raw.type, '-1');
  if (type === '2') {
    if (create && !fields.credit) return assetError('CREDIT_INFO_REQUIRED', '新增信用卡需要账单日、还款日和额度资料');
    const prior = raw.credit == null ? {} : asBillObject(raw.credit), credit = { ...prior }, value = fields.credit;
    if (value) {
      if (value.statementDay !== undefined) credit.statedate = value.statementDay;
      if (value.paymentDay !== undefined) credit.paydate2 = String(value.paymentDay);
      if (value.limit !== undefined) { if (compareMoney(value.limit, '0') < 0) return assetError('CREDIT_LIMIT_INVALID', '信用额度不能为负数'); credit.limit = new LosslessNumber(value.limit); }
      if (value.statementIncludesPrevious !== undefined) credit.statein = value.statementIncludesPrevious ? 1 : 0;
      if (value.sharedLimitAssetId !== undefined) {
        if (value.sharedLimitAssetId === numericText(raw.id, '')) return assetError('CREDIT_SHARED_SELF', '不能与自身共享额度');
        if (value.sharedLimitAssetId) { const target = loadAsset(ctx, command.scope, value.sharedLimitAssetId); if (numericText(target.type, '') !== '2' || numericText(target.currency, '') !== numericText(raw.currency, '')) return assetError('CREDIT_SHARED_ASSET_INVALID', '共享额度资产必须为相同币种的信用卡'); }
        credit.shareid = new LosslessNumber(value.sharedLimitAssetId ?? '-1');
      }
    }
    if (create && (credit.statedate === undefined || credit.paydate2 === undefined || credit.limit === undefined)) return assetError('CREDIT_INFO_REQUIRED', '请完整填写账单日、还款日和信用额度');
    raw.credit = credit;
  } else if (fields.credit !== undefined) return assetError('CREDIT_TYPE_REQUIRED', '只有信用卡支持额度及账期设置');
  return { input, raw, create };
}
export function assetMatchesIntent(actual: BillObject, expected: BillObject): boolean {
  for (const key of ['name', 'remark', 'type', 'stype', 'currency', 'incount', 'icon', 'color']) if (expected[key] !== undefined && numericText(actual[key], '') !== numericText(expected[key], '')) return false;
  if (compareMoney(moneyText(actual.money), moneyText(expected.money)) !== 0) return false;
  if (expected.credit != null) {
    if (actual.credit == null) return false;
    const a = asBillObject(actual.credit), b = asBillObject(expected.credit);
    for (const key of ['statedate', 'paydate2', 'statein', 'shareid']) if (b[key] !== undefined && numericText(a[key], '') !== numericText(b[key], '')) return false;
    if (b.limit !== undefined && compareMoney(moneyText(a.limit), moneyText(b.limit)) !== 0) return false;
  }
  return true;
}
