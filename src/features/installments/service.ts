import type { OperationContext } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import type { Coordinator } from '../../actor/coordinator';
import type { ConnectionService } from '../connection/service';
import type { ResourceCache } from '../../storage/cache';
import { DomainError } from '../../shared/errors';
import { asBillObject } from '../../shared/bill-wire';
import type { WireJson } from '../../shared/wire-json';
import { restoreBillInput } from '../ledger/write';
import { loadTransferAsset } from '../ledger/transfer';
import { safeProblem } from '../../operations/runner';
import { installmentDraftSchema, installmentQuerySchema, installmentPreviewSchema, type InstallmentDraft, type InstallmentDraftView, type InstallmentListView, type InstallmentPreviewInput, type InstallmentQuery } from './contract';
import { installmentBusinessDate, installmentKey, installmentView, refreshInstallments } from './source';
import { previewInstallment } from './preview';
export class InstallmentService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: OperationContext & { connection: Pick<ConnectionService, 'scope'>; cache: ResourceCache; coordinator?: Coordinator; baseCurrency?: () => string }) {}
  private scope() { const scope = this.dependencies.connection.scope(); if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
  async list(input: InstallmentQuery = {}): Promise<InstallmentListView> {
    const query = installmentQuerySchema.parse(input), scope = this.scope(), { cache, repository } = this.dependencies, key = installmentKey(query); let source = cache.read(scope, key), problem;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.needsValidation && connected) {
      const id = JSON.stringify([scope, key.queryKey]); let pending = this.#pending.get(id);
      if (!pending) { pending = refreshInstallments(this.dependencies, scope, query); this.#pending.set(id, pending); }
      try { await pending; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(id) === pending) this.#pending.delete(id); }
      source = cache.read(scope, key);
    }
    return { items: source.items.map((row) => installmentView(asBillObject(row.raw))).filter((row) => (!query.statuses || query.statuses.includes(row.status)) && (!query.assetId || query.assetId === row.assetId)), freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  preview(input: InstallmentPreviewInput) {
    const value = installmentPreviewSchema.parse(input), { assetId, ...amounts } = value, base = this.dependencies.baseCurrency?.() ?? 'CNY';
    const preview = previewInstallment(amounts, installmentBusinessDate(Math.floor(this.dependencies.clock.nowMs() / 1000), value.zone));
    return { ...preview, currency: assetId ? loadTransferAsset(this.dependencies, this.scope(), assetId, base).currency : base };
  }
  mutate(action: InstallmentDraft['action'], input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) throw new DomainError('ACTION_UNAVAILABLE', '分期写入尚未准备'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  getDraft(key: string): InstallmentDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `installment:${key}`); if (raw === null) return null; const draft = installmentDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, input: InstallmentDraft): InstallmentDraftView { const draft = installmentDraftSchema.parse(input), scope = this.scope(), previous = this.getDraft(key), operation = previous?.operationId ? this.dependencies.coordinator?.getOperation(scope, previous.operationId) : null; if (operation && !operationIsFinal(operation)) throw new DomainError('DRAFT_OPERATION_PENDING', '原分期操作尚未核清，请保留原草稿'); if (this.dependencies.coordinator?.store.find(scope, draft.requestId)) throw new DomainError('DRAFT_ALREADY_SUBMITTED', '原草稿已提交，请查看原操作'); this.dependencies.repository.saveDraft(scope, `installment:${key}`, draft); return { draft, operationId: null }; }
}
