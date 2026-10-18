import type { ActorScope } from '../../shared/model';
import type { OperationContext } from '../../operations/contract';
import type { WireJson } from '../../shared/wire-json';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { projectBill } from '../sync/incremental';
import { DomainError } from '../../shared/errors';
/** Apply official records only; preview objects never enter this boundary. */
export function applyPlanBills(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, values: WireJson, plan: { packId: string; bookId: string; types: readonly number[] }): string[] {
  if (values == null) return []; if (!Array.isArray(values) || values.length > 200) throw new DomainError('PLAN_BILLS_INVALID', '官方任务账单回执格式无法核对');
  const seen = new Set<string>(), bills = values.map((value) => { const bill = projectBill(value), raw = asBillObject(bill.raw); if (seen.has(bill.id) || numericText(raw.userid, '') !== scope.uid || numericText(raw.packid, '') !== plan.packId || bill.bookId !== plan.bookId || !plan.types.includes(bill.type)) throw new DomainError('PLAN_BILLS_SCOPE_INVALID', '官方任务账单不属于本次账号、分组、账本或类型'); seen.add(bill.id); return bill; });
  if (bills.length) { const dataset = ctx.repository.dataset(scope, 'ledger'); if (!dataset?.complete) throw new DomainError('LEDGER_INCOMPLETE', '请先完成账单同步，再接收任务生成的账单'); ctx.repository.applyPage(scope, dataset.id, { upserts: bills, deletes: [], resources: [], pageState: ctx.repository.syncState(scope, 'ledger', dataset.id)?.pageState ?? null }); } return bills.map((bill) => bill.id);
}
