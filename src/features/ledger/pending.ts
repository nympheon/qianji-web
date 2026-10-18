import type { MutationCommand, OperationContext } from '../../operations/contract';
import { DomainError } from '../../shared/errors';
/** Includes durable intents that have not yet produced a canonical Bill row. */
export function assertNoUnsyncedBills(ctx: Pick<OperationContext, 'repository'>, command: Pick<MutationCommand, 'scope'>) {
  const dataset = ctx.repository.dataset(command.scope, 'ledger');
  if (!dataset?.complete) throw new DomainError('LEDGER_INCOMPLETE', '请先完成账单同步');
  const rows = ctx.repository.sql.exec("SELECT 1 FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND type<>22 AND status_code IN(0,2) AND (COALESCE(json_extract(raw,'$.userid'),'')='' OR (CASE WHEN json_type(raw,'$.userid')='text' THEN json_extract(raw,'$.userid') ELSE raw -> '$.userid' END)=?) LIMIT 1", command.scope.uid, dataset.id, command.scope.uid).toArray();
  const pending = ctx.repository.sql.exec<{ state: string; items: string }>("SELECT state,items FROM operations WHERE uid=? AND (action LIKE 'ledger.%' OR action LIKE 'debt.%' OR action IN('repeat.submit','repeat.setPaused','installments.create','installments.prepay')) AND state IN('queued','sending','verifying','uncertain','partial')", command.scope.uid).toArray();
  if (rows.length || pending.some((row) => row.state !== 'partial' || (JSON.parse(row.items) as { state: string }[]).some((item) => !['succeeded', 'failed'].includes(item.state)))) throw new DomainError('UNSYNCED_BILLS', '账号内还有未同步或结果待核查的账单，请先处理原操作');
}
