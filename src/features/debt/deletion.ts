import type { OperationContext, ExpectedAssetEffect } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import type { BillRecord } from '../../storage/mirror';
import { asBillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { loadAsset } from '../assets/model';
import { debtCash, debtEffect, debtState } from './model';
import { debtCashDelta } from './accounting';
import { debtIds } from './bills';
import { DomainError } from '../../shared/errors';
export function debtDeletionEffects(record: BillRecord, ctx: OperationContext, scope: ActorScope, base: string): ExpectedAssetEffect[] {
  const raw = asBillObject(record.raw), { debtId, cashId } = debtIds(raw), cash = debtCash(ctx, scope, cashId, base);
  if (record.type === 10 || record.type === 11) return cash ? [debtEffect(cash, record.type === 10 ? record.money : subtractMoney('0', record.money), base)] : [];
  if (!debtId) throw new DomainError('DEBT_ASSET_REQUIRED', '借贷记录缺少借贷对象ID');
  const debt = loadAsset(ctx, scope, debtId), state = debtState(debt, base), principal = record.type === 6 || record.type === 7;
  const delta = (principal ? state.direction === 'borrow' : state.direction === 'lend') ? record.money : subtractMoney('0', record.money);
  let balance = addMoney(state.balance, delta);
  if (principal && (state.direction === 'borrow' ? compareMoney(balance, '0') > 0 : compareMoney(balance, '0') < 0)) balance = '0';
  // Native g(Bill) explicitly resets C to zero when LoanInfo.money==0.
  if (!principal && compareMoney(state.totalPrincipal, '0') === 0) balance = '0';
  return [debtEffect(debt, subtractMoney(balance, state.balance), base), ...(cash ? [debtEffect(cash, subtractMoney('0', debtCashDelta(state.direction, principal ? 'append' : 'pay', record.money)), base)] : [])];
}
