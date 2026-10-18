import type { Repository } from '../../storage/database';
import type { ResourceCache, CacheKey } from '../../storage/cache';
import type { QianjiClient } from '../../protocol/client';
import type { Clock } from '../../shared/model';
import type { ConnectionService } from '../connection/service';
import type { Coordinator } from '../../actor/coordinator';
import type { LedgerWriteService } from '../ledger/write-service';
import type { WireJson } from '../../shared/wire-json';
import type { CreateDebtInput, AppendPrincipalInput, EditPrincipalInput, DebtPaymentInput, DebtListInput, DebtListView, DebtDraft, DebtDraftView } from './contract';
import { debtListSchema, debtDraftSchema } from './contract';
import { asBillObject, numericText, positiveBillId } from '../../shared/bill-wire';
import { assetError, validateAsset } from '../assets/model';
import { debtView } from './model';
import { operationIsFinal } from '../../operations/contract';
import { prepareDebtBills } from './bills';
import { restoreBillInput } from '../ledger/write';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
export class DebtService {
  readonly #pending = new Map<string, Promise<void>>();
  constructor(private readonly dependencies: { repository: Repository; cache: ResourceCache; clock: Clock; client: QianjiClient; connection: Pick<ConnectionService, 'scope'>; coordinator?: Coordinator; ledgerWrites?: LedgerWriteService; baseCurrency?: () => string }) {}
  private scope() { return this.dependencies.connection.scope() ?? assetError('CONNECTION_REQUIRED', '请先连接钱迹'); }
  private mutate(action: string, input: WireJson, meta: { requestId: string }) { const coordinator = this.dependencies.coordinator; if (!coordinator) return assetError('ACTION_UNAVAILABLE', '借贷操作尚未启用'); return coordinator.submit({ action, input, scope: this.scope(), requestId: meta.requestId }); }
  create(input: CreateDebtInput, meta: { requestId: string }) { return this.mutate('debt.create', input, meta); }
  appendPrincipal(input: AppendPrincipalInput, meta: { requestId: string }) { return this.mutate('debt.appendPrincipal', input, meta); }
  editPrincipal(input: EditPrincipalInput, meta: { requestId: string }) { return this.mutate('debt.editPrincipal', input, meta); }
  pay(input: DebtPaymentInput, meta: { requestId: string }) { return this.mutate('debt.pay', input, meta); }
  options() { if (!this.dependencies.ledgerWrites) return assetError('ACTION_UNAVAILABLE', '借贷选项尚未准备'); return this.dependencies.ledgerWrites.transferOptions(); }
  preview(action: 'debt.appendPrincipal' | 'debt.editPrincipal' | 'debt.pay', input: AppendPrincipalInput | EditPrincipalInput | DebtPaymentInput) { return prepareDebtBills({ action, input, scope: this.scope(), requestId: 'preview' }, this.dependencies, this.dependencies.baseCurrency?.() ?? 'CNY').preview; }
  async list(input: DebtListInput): Promise<DebtListView> {
    const options = debtListSchema.parse(input), scope = this.scope(), { repository, cache, client } = this.dependencies, type = options.direction === 'borrow' ? 51 : 52, status = options.finished ? 1 : 0;
    const key: CacheKey = { domain: 'assets', queryKey: `asset:loans:${type}:${status}`, resourceKind: 'asset' }, fingerprint = JSON.stringify([scope.uid, scope.connectionEpoch, key.queryKey]);
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected'; let source = cache.read(scope, key), problem: Problem | undefined;
    if (source.stale && connected) {
      let pending = this.#pending.get(fingerprint);
      if (!pending) {
        pending = (async () => {
          const stamp = cache.captureRead(scope, key), reply = await client.request('asset.loans', { uid: scope.uid, t: type, status }, scope);
          if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 5000) return assetError('DEBT_LIST_INVALID', '借贷列表尚未完整返回或格式无法核对');
          const items = reply.data.map((value) => { const raw = validateAsset(asBillObject(value), scope); if (numericText(raw.type, '') !== '5' || numericText(raw.stype, '') !== String(type) || numericText(raw.status, '') !== String(status)) return assetError('DEBT_LIST_INVALID', '借贷列表方向或状态不匹配'); return { id: positiveBillId(raw.id)!, kind: 'asset' as const, raw }; });
          if (new Set(items.map((item) => item.id)).size !== items.length) return assetError('DEBT_LIST_INVALID', '借贷列表包含重复ID');
          if (cache.applyRead(stamp, { items, complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '借贷读取期间发生变化，请重新查看');
        })(); this.#pending.set(fingerprint, pending);
      }
      try { await pending; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(fingerprint) === pending) this.#pending.delete(fingerprint); }
      source = cache.read(scope, key);
    }
    return { items: source.items.map((item) => debtView(asBillObject(item.raw), this.dependencies.baseCurrency?.() ?? 'CNY')), freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  getDraft(key: string): DebtDraftView | null {
    const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `debt:${key}`); if (raw === null) return null;
    const draft = debtDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null };
  }
  saveDraft(key: string, draft: DebtDraft): DebtDraftView {
    draft = debtDraftSchema.parse(draft); const scope = this.scope(), previous = this.getDraft(key), coordinator = this.dependencies.coordinator;
    const operation = previous?.operationId ? coordinator?.getOperation(scope, previous.operationId) : null;
    if (operation && !operationIsFinal(operation)) return assetError('DRAFT_OPERATION_PENDING', '原借贷结果尚未核清，请查看原操作');
    if (coordinator?.store.find(scope, draft.requestId)) return assetError('DRAFT_ALREADY_SUBMITTED', '该草稿已提交，请查看原操作');
    this.dependencies.repository.saveDraft(scope, `debt:${key}`, { ...draft, input: { ...draft.input } }); return { draft, operationId: null };
  }
}
