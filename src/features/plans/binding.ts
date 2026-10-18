import type { ActorScope } from '../../shared/model';
import type { OperationContext } from '../../operations/contract';
import type { PlanBindingInput } from './contract';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { DomainError } from '../../shared/errors';
/** A negative/absent pack and another positive pack both satisfy unbind-this-plan. */
export function planBindingGoal(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, input: PlanBindingInput): boolean {
  const bill = ctx.repository.readBill(scope, input.billId); if (!bill) return !input.bound;
  return (numericText(asBillObject(bill.raw).packid, '-1') === input.packId) === input.bound;
}
export function validatePlanBinding(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, input: PlanBindingInput, plan: { id: string; packId: string | null; allowedTypes: readonly number[] }) {
  if (plan.id !== input.planId || plan.packId !== input.packId) throw new DomainError('PLAN_PACK_CHANGED', '任务与账单分组关系已变化，请重新查看');
  const bill = ctx.repository.readBill(scope, input.billId); if (!bill) { if (!input.bound) return true; throw new DomainError('BILL_NOT_LOADED', '所选已有账单尚未载入'); }
  if (numericText(asBillObject(bill.raw).userid, '') !== scope.uid) throw new DomainError('BILL_NOT_OWNED', '只能关联自己创建的账单');
  if (!plan.allowedTypes.includes(bill.type) && !planBindingGoal(ctx, scope, input)) throw new DomainError('PLAN_BILL_TYPE_MISMATCH', '账单类型与此任务不匹配'); return planBindingGoal(ctx, scope, input);
}
