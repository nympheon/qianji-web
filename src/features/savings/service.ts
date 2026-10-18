import type { OperationContext } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import type { Coordinator } from '../../actor/coordinator';
import type { ConnectionService } from '../connection/service';
import type { ResourceCache } from '../../storage/cache';
import { DomainError } from '../../shared/errors';
import { asBillObject } from '../../shared/bill-wire';
import type { WireJson } from '../../shared/wire-json';
import { restoreBillInput } from '../ledger/write';
import { safeProblem } from '../../operations/runner';
import { savingsDraftSchema, savingsQuerySchema, savingsProjectSchema, type SavingsDraft, type SavingsDraftView, type SavingsListView, type SavingsQuery } from './contract';
import { savingsKey, savingsView, refreshSavings } from './source';
import { projectSavings } from './projection';
export class SavingsService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: OperationContext & { connection: Pick<ConnectionService, 'scope'>; cache: ResourceCache; coordinator?: Coordinator }) {}
  private scope() { const scope = this.dependencies.connection.scope(); if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
  async list(input: SavingsQuery = {}): Promise<SavingsListView> {
    const query = savingsQuerySchema.parse(input), scope = this.scope(), { cache, repository } = this.dependencies, key = savingsKey; let source = cache.read(scope, key), problem;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.stale && connected) {
      const id = JSON.stringify([scope, key.queryKey]); let pending = this.#pending.get(id);
      if (!pending) { pending = refreshSavings(this.dependencies, scope); this.#pending.set(id, pending); }
      try { await pending; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(id) === pending) this.#pending.delete(id); }
      source = cache.read(scope, key);
    }
    return { items: source.items.map((row) => savingsView(asBillObject(row.raw))).filter((row) => (!query.statuses || query.statuses.some(status=>status===row.status))), freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  project(input: import('zod').input<typeof savingsProjectSchema>) { const value=savingsProjectSchema.parse(input);return projectSavings(value.rule,value.limit); }
  mutate(action: SavingsDraft['action'], input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) throw new DomainError('ACTION_UNAVAILABLE', '储蓄写入尚未准备'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  getDraft(key: string): SavingsDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `saving:${key}`); if (raw === null) return null; const draft = savingsDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, input: SavingsDraft): SavingsDraftView { const draft = savingsDraftSchema.parse(input), scope = this.scope(), previous = this.getDraft(key), operation = previous?.operationId ? this.dependencies.coordinator?.getOperation(scope, previous.operationId) : null; if (operation && !operationIsFinal(operation)) throw new DomainError('DRAFT_OPERATION_PENDING', '原储蓄操作尚未核清，请保留原草稿'); if (this.dependencies.coordinator?.store.find(scope, draft.requestId)) throw new DomainError('DRAFT_ALREADY_SUBMITTED', '原草稿已提交，请查看原操作'); this.dependencies.repository.saveDraft(scope, `saving:${key}`, draft); return { draft, operationId: null }; }
}
