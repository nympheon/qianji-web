import type { ActorScope } from '../../shared/model';
import type { OperationContext, ExpectedAssetEffect } from '../../operations/contract';
import { asBillObject, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { assetError, assetView, loadAsset } from '../assets/model';
import { addMoney, compareMoney } from '../../shared/numbers';
import type { DebtState } from './accounting';
import type { DebtView } from './contract';
export function debtState(raw: BillObject, baseCurrency = 'CNY'): DebtState {
  if (numericText(raw.type, '') !== '5' || !['51', '52'].includes(numericText(raw.stype, ''))) return assetError('DEBT_ASSET_REQUIRED', '请选择借入或借出资产');
  if (typeof raw.currency === 'string' && raw.currency && raw.currency !== baseCurrency) return assetError('DEBT_CURRENCY_UNSUPPORTED', '借贷仅支持本位币');
  if (raw.loan == null) return assetError('DEBT_LOAN_INFO_MISSING', '借贷资料缺少LoanInfo，请先刷新或在手机客户端核查');
  const loan = asBillObject(raw.loan);
  if (loan.money == null || loan.totalpay == null) return assetError('DEBT_LOAN_INFO_MISSING', '借贷资料缺少本金或已还本金，不能按零推算');
  const direction = numericText(raw.stype, '') === '51' ? 'borrow' : 'lend';
  const state = { direction, balance: moneyText(raw.money), totalPrincipal: moneyText(loan.money), totalPaid: moneyText(loan.totalpay) } satisfies DebtState;
  if (compareMoney(state.totalPaid, '0') < 0 || (direction === 'borrow' ? compareMoney(state.balance, '0') > 0 || compareMoney(state.totalPrincipal, '0') > 0 : compareMoney(state.balance, '0') < 0 || compareMoney(state.totalPrincipal, '0') < 0)) return assetError('DEBT_STATE_INVALID', '借贷余额或本金方向不一致，请核查官方资料');
  return state;
}
export function debtView(raw: BillObject, baseCurrency = 'CNY'): DebtView {
  const loan = raw.loan == null ? null : asBillObject(raw.loan), missing = !loan || loan.money == null || loan.totalpay == null;
  return { asset: assetView(raw, baseCurrency), state: missing ? null : debtState(raw, baseCurrency), aboutAssetId: loan ? positiveBillId(loan.accountId) : null, startDate: loan && typeof loan.startdate === 'string' ? loan.startdate : null, endDate: loan && typeof loan.enddate === 'string' ? loan.enddate : null, loanInfoMissing: missing };
}
export function debtCash(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, id: string | null | undefined, baseCurrency: string): BillObject | null {
  if (!id) return null;
  const raw = loadAsset(ctx, scope, id), view = assetView(raw, baseCurrency);
  if (![1, 2, 3, 4].includes(view.type) || view.currency !== baseCurrency || view.status !== 0) return assetError('DEBT_CASH_ASSET_INVALID', '关联资产必须为正常状态、本位币的普通资产或信用卡');
  return raw;
}
export function debtEffect(raw: BillObject, delta: string, baseCurrency: string): ExpectedAssetEffect {
  const view = assetView(raw, baseCurrency); return { assetId: view.id, currency: view.currency, delta, balanceBefore: view.money, expectedBalance: addMoney(view.money, delta), confirmation: 'expected' };
}
