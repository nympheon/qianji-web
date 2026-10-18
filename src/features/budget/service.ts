import type { Repository } from '../../storage/database';
import type { Clock } from '../../shared/model';
import type { QianjiClient } from '../../protocol/client';
import type { ResourceCache } from '../../storage/cache';
import type { ConnectionService } from '../connection/service';
import type { Coordinator } from '../../actor/coordinator';
import type { BillFilter } from '../ledger/contract';
import { budgetChangesSchema, budgetDraftSchema, budgetQuerySchema, type BudgetChangesInput, type BudgetDraft, type BudgetDraftView, type BudgetLedgerSource, type BudgetQueryInput, type BudgetView } from './contract';
import { budgetKey, budgetRange, parseBudgets, refreshBudget } from './source';
import { assetError } from '../assets/model';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
import { restoreBillInput } from '../ledger/write';
import { operationIsFinal } from '../../operations/contract';
import { calculateBudget } from './calculate';
import { compareMoney, divideMoney } from '../../shared/numbers';
import { businessDay } from '../ledger/query';
export class BudgetService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: { repository: Repository; clock: Clock; client: QianjiClient; cache: ResourceCache; connection: Pick<ConnectionService, 'scope'>; coordinator?: Coordinator; ledger: { budgetSource(input: BillFilter): Promise<BudgetLedgerSource> }; baseCurrency(): string }) {}
  private scope() { return this.dependencies.connection.scope() ?? assetError('CONNECTION_REQUIRED', '请先连接钱迹'); }
  submit(input: BudgetChangesInput, meta: { requestId: string }) { input = budgetChangesSchema.parse(input); if (!this.dependencies.coordinator) return assetError('ACTION_UNAVAILABLE', '预算写入尚未准备'); return this.dependencies.coordinator.submit({ action: 'budget.submit', input, requestId: meta.requestId, scope: this.scope() }); }
  async list(input: BudgetQueryInput): Promise<BudgetView> {
    const query = budgetQuerySchema.parse(input), range = budgetRange(query), scope = this.scope(), { repository, cache, clock } = this.dependencies, key = budgetKey(query); let source = cache.read(scope, key), problem: Problem | undefined;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.stale && connected) { const id = JSON.stringify([scope, key.queryKey]); let pending = this.#pending.get(id); if (!pending) { pending = refreshBudget(this.dependencies, scope, query); this.#pending.set(id, pending); } try { await pending; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(id) === pending) this.#pending.delete(id); } source = cache.read(scope, key); }
    const value = parseBudgets(source.items[0]?.raw ?? { list: [] }, query), currency = this.dependencies.baseCurrency(), ledger = await this.dependencies.ledger.budgetSource({ bookIds: [query.bookId], includeHiddenBooks: true, date: { kind: 'range', from: businessDay(range.startSec, query.zone), to: businessDay(range.endSec, query.zone) }, zone: query.zone });
    const progress = calculateBudget({ bills: ledger.bills, budgets: value.configurations.map((row) => ({ id: row.categoryId ?? 'total', categoryId: row.categoryId, limit: row.limit })), categories: ledger.categories, range, currency, nowSec: Math.floor(clock.nowMs() / 1000) });
    const incompleteReasons = [...new Set([...ledger.incompleteReasons, ...progress.incompleteReasons, ...(!source.complete ? ['BUDGET_SOURCE_INCOMPLETE'] : [])])], total = progress.rows.find((row) => row.categoryId === null);
    const syncedAt = [source.validatedAt === null ? null : new Date(source.validatedAt).toISOString(), ledger.freshness.syncedAt].filter((value): value is string => value !== null).sort()[0] ?? null;
    return { query, configurations: value.configurations, dayStats: value.dayStats, currency, editVersion: value.editVersion, progress, dailyAvailable: total && compareMoney(total.limit, '0') > 0 && progress.remainingDays > 0 ? divideMoney(total.remaining, String(progress.remainingDays)) : null, incompleteReasons, freshness: { revision: `${source.revision}|${ledger.freshness.revision}|${currency}`, complete: source.complete && ledger.freshness.complete && incompleteReasons.length === 0, stale: source.stale || ledger.freshness.stale || !connected || !!problem, syncedAt }, ...(problem ? { problem } : {}) };
  }
  getDraft(key: string): BudgetDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `budget:${key}`); if (raw === null) return null; const draft = budgetDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, draft: BudgetDraft): BudgetDraftView { draft = budgetDraftSchema.parse(draft); const scope = this.scope(), previous = this.getDraft(key), coordinator = this.dependencies.coordinator, operation = previous?.operationId ? coordinator?.getOperation(scope, previous.operationId) : null; if (operation && !operationIsFinal(operation)) return assetError('DRAFT_OPERATION_PENDING', '原预算操作尚未核清，请查看原操作'); if (coordinator?.store.find(scope, draft.requestId)) return assetError('DRAFT_ALREADY_SUBMITTED', '此草稿已提交，请查看原操作'); this.dependencies.repository.saveDraft(scope, `budget:${key}`, draft); return { draft, operationId: null }; }
}
