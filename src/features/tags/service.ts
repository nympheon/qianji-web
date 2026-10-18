import type { Repository } from '../../storage/database';
import type { Clock } from '../../shared/model';
import type { QianjiClient } from '../../protocol/client';
import type { ResourceCache } from '../../storage/cache';
import type { ConnectionService } from '../connection/service';
import type { Coordinator } from '../../actor/coordinator';
import type { WireJson } from '../../shared/wire-json';
import { tagDraftSchema, tagListSchema, type TagDraft, type TagDraftView, type TagListInput, type TagListView } from './contract';
import { refreshTags, tagCatalogKey, tagGroupView, tagView } from './source';
import { assetError } from '../assets/model';
import { asBillObject } from '../../shared/bill-wire';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
import { restoreBillInput } from '../ledger/write';
import { operationIsFinal } from '../../operations/contract';
export class TagService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: { repository: Repository; clock: Clock; client: QianjiClient; cache: ResourceCache; connection: Pick<ConnectionService, 'scope'>; coordinator?: Coordinator }) {}
  private scope() { return this.dependencies.connection.scope() ?? assetError('CONNECTION_REQUIRED', '请先连接钱迹'); }
  mutate(action: TagDraft['action'], input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) return assetError('ACTION_UNAVAILABLE', '标签写入尚未准备'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  async list(input: TagListInput = {}): Promise<TagListView> {
    const options = tagListSchema.parse(input), scope = this.scope(), { cache, repository } = this.dependencies; let source = cache.read(scope, tagCatalogKey), problem: Problem | undefined;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.needsValidation && connected) { const key = JSON.stringify(scope); let task = this.#pending.get(key); if (!task) { task = refreshTags(this.dependencies, scope); this.#pending.set(key, task); } try { await task; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(key) === task) this.#pending.delete(key); } source = cache.read(scope, tagCatalogKey); }
    return { items: source.items.filter((item) => item.kind === 'tag').map((item) => tagView(asBillObject(item.raw))).filter((item) => (options.includeArchived || !item.archived) && (options.groupId === undefined || item.groupId === options.groupId)).sort((a, b) => a.sort - b.sort), groups: source.items.filter((item) => item.kind === 'tagGroup').map((item) => tagGroupView(asBillObject(item.raw))).sort((a, b) => a.sort - b.sort), freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  getDraft(key: string): TagDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `tag:${key}`); if (raw === null) return null; const draft = tagDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, draft: TagDraft): TagDraftView { draft = tagDraftSchema.parse(draft); const scope = this.scope(), previous = this.getDraft(key), coordinator = this.dependencies.coordinator, operation = previous?.operationId ? coordinator?.getOperation(scope, previous.operationId) : null; if (operation && !operationIsFinal(operation)) return assetError('DRAFT_OPERATION_PENDING', '原标签操作尚未核清，请查看原操作'); if (coordinator?.store.find(scope, draft.requestId)) return assetError('DRAFT_ALREADY_SUBMITTED', '此草稿已提交，请查看原操作'); this.dependencies.repository.saveDraft(scope, `tag:${key}`, { ...draft, input: { ...draft.input } }); return { draft, operationId: null }; }
}
