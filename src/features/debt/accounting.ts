import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { DomainError } from '../../shared/errors';
export interface DebtState { direction: 'borrow' | 'lend'; balance: string; totalPrincipal: string; totalPaid: string }
export function debtAbsolute(value: string): string { return compareMoney(value, '0') < 0 ? subtractMoney('0', value) : addMoney(value); }
export function debtAmount(value: string): string { const result = debtAbsolute(value); if (compareMoney(result, '9999999999') > 0) throw new DomainError('DEBT_AMOUNT_LIMIT', '本金和利息各自不能超过9,999,999,999'); return result; }
const clamp = (value: string, direction: DebtState['direction']) => direction === 'borrow' ? compareMoney(value, '0') > 0 ? '0' : value : compareMoney(value, '0') < 0 ? '0' : value;
/** G0 runs principal normalization after the supplied interest; overflow replaces interest via F0. */
export function splitDebtPayment(balance: string, enteredPrincipal: string, enteredInterest = '0'): { principal: string; interest: string; overflow: boolean } {
  const entered = debtAbsolute(enteredPrincipal), available = debtAbsolute(balance), overflow = compareMoney(entered, available) > 0;
  const principal = overflow ? available : entered, interest = overflow ? subtractMoney(entered, available) : debtAbsolute(enteredInterest);
  return { principal: debtAmount(principal), interest: debtAmount(interest), overflow };
}
export function principalState(state: DebtState, principal: string, previous = '0'): DebtState {
  const delta = subtractMoney(debtAmount(principal), debtAmount(previous));
  const totalPrincipal = state.direction === 'borrow' ? subtractMoney(state.totalPrincipal, delta) : addMoney(state.totalPrincipal, delta);
  const balance = state.direction === 'borrow' ? addMoney(totalPrincipal, state.totalPaid) : subtractMoney(totalPrincipal, state.totalPaid);
  return { ...state, totalPrincipal, balance: clamp(balance, state.direction) };
}
export function paymentState(state: DebtState, principal: string): DebtState {
  const amount = debtAmount(principal), balance = state.direction === 'borrow' ? addMoney(state.balance, amount) : subtractMoney(debtAbsolute(state.balance), amount);
  return { ...state, balance: clamp(balance, state.direction), totalPaid: addMoney(state.totalPaid, amount) };
}
export function debtCashDelta(direction: DebtState['direction'], kind: 'append' | 'pay', principal: string, interest = '0'): string {
  const amount = kind === 'append' ? debtAmount(principal) : addMoney(debtAmount(principal), debtAmount(interest));
  return (kind === 'append' ? direction === 'borrow' : direction === 'lend') ? amount : subtractMoney('0', amount);
}
