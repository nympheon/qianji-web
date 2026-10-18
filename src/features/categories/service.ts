import type { Repository } from '../../storage/database';
import type { QianjiClient } from '../../protocol/client';
import type { Clock } from '../../shared/model';
import type { ResourceCache } from '../../storage/cache';
import type { ConnectionService } from '../connection/service';
import { categoryCheckSchema, categoryListSchema, type CategoryListInput, type CategoryCheckInput, type CategoryListView, type CategoryDeleteCheckView } from './contract';
import { categoryCounts, categoryView } from './model';
import { categoryKey, refreshCategories } from './source';
import { assetError } from '../assets/model';
import { asBillObject } from '../../shared/bill-wire';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
import type { Coordinator } from '../../actor/coordinator';
import type { WireJson } from '../../shared/wire-json';
import { categoryDraftSchema, type CategoryDraft, type CategoryDraftView, type CategorySubmitInput, type CategoryLevelInput, type CategoryMoveInput, type CategoryReorderInput, type DeleteCategoryInput } from './contract';
import { restoreBillInput } from '../ledger/write';
import { operationIsFinal } from '../../operations/contract';
export class CategoryService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: { repository: Repository; client: QianjiClient; clock: Clock; cache: ResourceCache; connection: Pick<ConnectionService, 'scope'>; coordinator?: Coordinator }) {}
  private scope() { return this.dependencies.connection.scope() ?? assetError('CONNECTION_REQUIRED', '请先连接钱迹'); }
  private mutate(action: string, input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) return assetError('ACTION_UNAVAILABLE', '分类写入尚未准备'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  submit(input: CategorySubmitInput, meta: { requestId: string }) { return this.mutate('categories.submit', input, meta); }
  changeLevel(input: CategoryLevelInput, meta: { requestId: string }) { return this.mutate('categories.changeLevel', input, meta); }
  move(input: CategoryMoveInput, meta: { requestId: string }) { return this.mutate('categories.move', input, meta); }
  reorder(input: CategoryReorderInput, meta: { requestId: string }) { return this.mutate('categories.reorder', input, meta); }
  remove(input: DeleteCategoryInput, meta: { requestId: string }) { return this.mutate('categories.delete', input, meta); }
  getDraft(key: string): CategoryDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `category:${key}`); if (raw === null) return null; const draft = categoryDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, draft: CategoryDraft): CategoryDraftView {
    draft = categoryDraftSchema.parse(draft); const scope = this.scope(), previous = this.getDraft(key), coordinator = this.dependencies.coordinator, operation = previous?.operationId ? coordinator?.getOperation(scope, previous.operationId) : null;
    if (operation && !operationIsFinal(operation)) return assetError('DRAFT_OPERATION_PENDING', '原分类操作尚未核清，请查看原操作'); if (coordinator?.store.find(scope, draft.requestId)) return assetError('DRAFT_ALREADY_SUBMITTED', '此草稿已提交，请查看原操作');
    this.dependencies.repository.saveDraft(scope, `category:${key}`, { ...draft, input: { ...draft.input } }); return { draft, operationId: null };
  }
  async list(input: CategoryListInput): Promise<CategoryListView> {
    input = categoryListSchema.parse(input); const scope = this.scope(), { repository, cache } = this.dependencies, key = categoryKey(input); let source = cache.read(scope, key), problem: Problem | undefined;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.stale && connected) { const id = JSON.stringify([scope.uid, scope.connectionEpoch, key.queryKey]); let pending = this.#pending.get(id); if (!pending) { pending = refreshCategories(this.dependencies, scope, input); this.#pending.set(id, pending); } try { await pending; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(id) === pending) this.#pending.delete(id); } source = cache.read(scope, key); }
    const raw = source.items.map((item) => asBillObject(item.raw)); return { bookId: input.bookId, type: input.type, items: raw.map((item) => categoryView(item, raw)), freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  async checkDelete(input: CategoryCheckInput): Promise<CategoryDeleteCheckView> {
    input = categoryCheckSchema.parse(input); const scope = this.scope(), raw = await refreshCategories(this.dependencies, scope, input), category = raw.find((value) => categoryView(value).id === input.id); if (!category) return assetError('CATEGORY_NOT_LOADED', '目标分类尚未载入'); const view = categoryView(category, raw), hasChildren = view.childIds.length > 0;
    if (hasChildren) return { id: input.id, hasChildren, blocked: true, expectedVersion: view.editVersion, count: null, other: null };
    const reply = await this.dependencies.client.request('category.deleteCheck', { uid: scope.uid, did: input.id }, scope); return { id: input.id, hasChildren, blocked: !view.editable, expectedVersion: view.editVersion, ...categoryCounts(asBillObject(reply.data)) };
  }
}
