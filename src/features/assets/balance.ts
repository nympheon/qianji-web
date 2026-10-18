import type { MutationCommand, OperationContext } from '../../operations/contract';
import { moneyText, numericText, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import { billVersion, restoreBillInput } from '../ledger/write';
import { balanceAdjustmentSchema } from './contract';
import { assetError, loadAsset } from './model';
import { nativeInstallmentMoney } from './summary';
import { assertNoUnsyncedBills } from '../ledger/pending';
import { assertImageReferences } from '../attachments/references';
export function prepareBalance(command: MutationCommand, ctx: OperationContext) {
  const input = balanceAdjustmentSchema.parse(restoreBillInput(command.input)), raw = { ...loadAsset(ctx, command.scope, input.id) };
  if (billVersion(raw) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '资产已变化，请保留输入并重新查看');
  if (![1, 2, 3, 4].includes(Number(numericText(raw.type, '-1')))) return assetError('ASSET_BALANCE_TYPE_UNSUPPORTED', '借贷余额请通过本金或还款操作维护');
  const installments = nativeInstallmentMoney(raw);
  if (!installments.complete) return assetError('INSTALLMENT_DATA_MISSING', '分期资料不足，暂时不能核对原生余额');
  // Native C(): entered balance includes outstanding installments; stored money adds them back.
  const stored = compareMoney(installments.money, '0') > 0 ? addMoney(input.money, installments.money) : input.money;
  const delta = subtractMoney(stored, moneyText(raw.money));
  if (compareMoney(delta, '0') !== 0) assertNoUnsyncedBills(ctx, command);
  else if (input.recordDifference) return assetError('DIFFERENCE_UNCHANGED', '余额没有变化，无需记录差额');
  raw.money = new LosslessNumber(stored);
  const params: BillObject = { uid: command.scope.uid, v: '' };
  if (input.recordDifference) {
    const difference = input.difference!;
    params.diffparams = { cateid: new LosslessNumber(difference.categoryId), billflag: (difference.countInStatistics ? 0 : 1) | (difference.countInBudget ? 0 : 2), ...(difference.remark ? { remark: difference.remark } : {}) };
    if (difference.images?.length) params.diffparams.images = assertImageReferences(ctx, command.scope, difference.images);
  }
  return { input, raw, params, delta };
}
