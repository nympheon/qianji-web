import type { MutationCommand, OperationContext } from '../../operations/contract';
import { moneyText, numericText, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import { billVersion, restoreBillInput } from '../ledger/write';
import { balanceAdjustmentSchema } from './contract';
import { assetError, loadAsset } from './model';
import { nativeInstallmentMoney } from './summary';
export function assertNoUnsyncedBills(ctx: OperationContext, command: MutationCommand) {
  const dataset = ctx.repository.dataset(command.scope, 'ledger');
  if (!dataset?.complete) return assetError('LEDGER_INCOMPLETE', '余额修改前请完成账单同步');
  const rows = ctx.repository.sql.exec("SELECT 1 FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND type<>22 AND status_code IN(0,2) AND (COALESCE(json_extract(raw,'$.userid'),'')='' OR (CASE WHEN json_type(raw,'$.userid')='text' THEN json_extract(raw,'$.userid') ELSE raw -> '$.userid' END)=?) LIMIT 1", command.scope.uid, dataset.id, command.scope.uid).toArray();
  const pending = ctx.repository.sql.exec<{ state: string; items: string }>("SELECT state,items FROM operations WHERE uid=? AND (action LIKE 'ledger.%' OR action LIKE 'debt.%') AND state IN('queued','sending','verifying','uncertain','partial')", command.scope.uid).toArray();
  if (rows.length || pending.some((row) => row.state !== 'partial' || (JSON.parse(row.items) as { state: string }[]).some((item) => !['succeeded', 'failed'].includes(item.state)))) return assetError('UNSYNCED_BILLS', '账号内还有未同步或结果待核查的账单，请先处理原操作');
}
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
    if (difference.images?.length) return assetError('ATTACHMENT_UNVERIFIED', '差额图片需先完成附件上传验收');
    params.diffparams = { cateid: new LosslessNumber(difference.categoryId), billflag: (difference.countInStatistics ? 0 : 1) | (difference.countInBudget ? 0 : 2), ...(difference.remark ? { remark: difference.remark } : {}) };
  }
  return { input, raw, params, delta };
}
