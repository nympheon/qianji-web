import type { Repository } from '../../storage/database';
import type { Clock } from '../../shared/model';
import type { QianjiClient } from '../../protocol/client';
import type { ResourceCache, CacheKey, CacheView } from '../../storage/cache';
import type { ConnectionService } from '../connection/service';
import { bookListSchema, bookDraftSchema, type BookListInput, type BookListView, type BookTypesView, type BookMembersView, type BookSubmitInput, type BookConfigureInput, type BookDeleteInput, type BookQuitInput, type BookVisibleInput, type BookReorderInput, type BaseCurrencyInput, type BookDraft, type BookDraftView } from './contract';
import { bookView, parseBookDeleteCheck } from './model';
import { refreshBooks, bookListKey } from './source';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { assetError } from '../assets/model';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
import type { ResourceRecord } from '../../storage/resources';
import type { ActorScope } from '../../shared/model';
import type { Coordinator } from '../../actor/coordinator';
import type { WireJson } from '../../shared/wire-json';
import { operationIsFinal } from '../../operations/contract';
import { restoreBillInput } from '../ledger/write';
import type { AccountingConfiguration } from './accounting';
export class BookService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: { repository: Repository; clock: Clock; client: QianjiClient; cache: ResourceCache; connection: Pick<ConnectionService, 'scope'> & Partial<Pick<ConnectionService, 'check'>>; vipExpired?: () => boolean; coordinator?: Coordinator; accounting?: AccountingConfiguration }) {}
  private scope() { return this.dependencies.connection.scope() ?? assetError('CONNECTION_REQUIRED', '请先连接钱迹'); }
  private mutate(action: string, input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) return assetError('ACTION_UNAVAILABLE', '账本写入尚未准备'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  submit(input: BookSubmitInput, meta: { requestId: string }) { return this.mutate('books.submit', input, meta); }
  configure(input: BookConfigureInput, meta: { requestId: string }) { return this.mutate('books.configure', input, meta); }
  remove(input: BookDeleteInput, meta: { requestId: string }) { return this.mutate('books.delete', input, meta); }
  quit(input: BookQuitInput, meta: { requestId: string }) { return this.mutate('books.quit', input, meta); }
  setVisible(input: BookVisibleInput, meta: { requestId: string }) { return this.mutate('books.setVisible', input, meta); }
  reorder(input: BookReorderInput, meta: { requestId: string }) { return this.mutate('books.reorder', input, meta); }
  setBaseCurrency(input: BaseCurrencyInput, meta: { requestId: string }) { return this.mutate('books.setBaseCurrency', input, meta); }
  async accounting() {
    const config = this.dependencies.accounting; if (!config) return assetError('ACTION_UNAVAILABLE', '本位币配置尚未准备');
    const scope = this.scope(), current = config.read(scope), connected = this.dependencies.repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (current.freshness.stale && connected && this.dependencies.connection.check) await this.dependencies.connection.check();
    return config.read(scope);
  }
  private async resources(key: CacheKey, load: (scope: ActorScope) => Promise<ResourceRecord[]>): Promise<CacheView & { problem?: Problem }> {
    const scope = this.scope(), { cache, repository } = this.dependencies;
    const current = cache.read(scope, key), connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected'; if (!current.stale || !connected) return current;
    const id = JSON.stringify([scope.uid, scope.connectionEpoch, key.queryKey]); let pending = this.#pending.get(id);
    if (!pending) { pending = (async () => { const stamp = cache.captureRead(scope, key), items = await load(scope); if (cache.applyRead(stamp, { items, complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '账本资料读取期间发生变化，请重新查看'); })(); this.#pending.set(id, pending); }
    try { await pending; return cache.read(scope, key); } catch (error) { return { ...cache.read(scope, key), problem: safeProblem(error) }; } finally { if (this.#pending.get(id) === pending) this.#pending.delete(id); }
  }
  private freshness(source: CacheView & { problem?: Problem }) { const connected = this.dependencies.repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected'; return { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!source.problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }; }
  async types(): Promise<BookTypesView> {
    const source = await this.resources({ domain: 'books', queryKey: 'book:types', resourceKind: 'bookType' }, async (scope) => {
      const reply = await this.dependencies.client.request('book.types', { uid: scope.uid }, scope); if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 500) return assetError('BOOK_TYPES_INVALID', '账本类型列表无法核对');
      return reply.data.map((value) => { const raw = asBillObject(value), type = Number(numericText(raw.type, '')); if (!Number.isSafeInteger(type) || typeof raw.name !== 'string') return assetError('BOOK_TYPES_INVALID', '账本类型缺少名称或编码'); return { id: String(type), kind: 'bookType', raw }; });
    });
    return { items: source.items.map((item) => { const raw = asBillObject(item.raw); return { type: Number(numericText(raw.type, '0')), name: String(raw.name), cover: typeof raw.cover === 'string' ? raw.cover : null, description: typeof raw.desc === 'string' ? raw.desc : '', range: typeof raw.range === 'string' ? raw.range : '' }; }), freshness: this.freshness(source), ...(source.problem ? { problem: source.problem } : {}) };
  }
  async members(id: string): Promise<BookMembersView> {
    const scope = this.scope(), row = this.dependencies.repository.readResources(scope, 'book', { domain: 'books', ids: [id] }).items[0]; if (!row) return assetError('BOOK_NOT_LOADED', '请先载入账本资料'); const owner = numericText(asBillObject(row.raw).userid, '');
    const source = await this.resources({ domain: 'books', queryKey: `book:members:${id}`, resourceKind: 'bookMember' }, async (scope) => {
      const reply = await this.dependencies.client.request('book.members', { uid: scope.uid, bookid: id }, scope); if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 1000) return assetError('BOOK_MEMBERS_INVALID', '账本成员列表未完整返回');
      const items = reply.data.map((value) => { const raw = asBillObject(value), uid = numericText(raw.id, ''); if (!uid || raw.bookid !== undefined && numericText(raw.bookid, '') !== id) return assetError('BOOK_MEMBERS_INVALID', '成员缺少ID或属于其他账本'); return { id: `${id}:${uid}`, kind: 'bookMember' as const, raw: { ...raw, bookid: id } }; }); if (new Set(items.map((item) => item.id)).size !== items.length) return assetError('BOOK_MEMBERS_INVALID', '成员列表包含重复ID'); return items;
    });
    return { bookId: id, items: source.items.map((item) => { const raw = asBillObject(item.raw), uid = numericText(raw.id, ''); return { id: uid, name: typeof raw.name === 'string' ? raw.name : '', avatar: typeof raw.avatar === 'string' ? raw.avatar : null, role: uid === owner ? 'owner' : 'member', vipType: numericText(raw.viptype, '0'), vipEndSec: raw.vipend == null ? null : numericText(raw.vipend, '') }; }), freshness: this.freshness(source), ...(source.problem ? { problem: source.problem } : {}) };
  }
  async checkDelete(id: string) {
    const scope = this.scope(), raw = (await refreshBooks(this.dependencies, scope)).find((book) => book.id === id)?.raw; if (!raw) return assetError('BOOK_NOT_LOADED', '账本已不可访问'); const book = bookView(raw, scope.uid, this.dependencies.vipExpired?.() ?? false);
    if (book.defaultBook) return { id, expectedVersion: book.editVersion, role: book.role, defaultBook: true, blocked: true, ownerHasUnresolved: false, memberHasUnresolved: false };
    const reply = await this.dependencies.client.request('book.deleteCheck', { uid: scope.uid, bookid: id }, scope); return { id, expectedVersion: book.editVersion, role: book.role, defaultBook: false, ...parseBookDeleteCheck(asBillObject(reply.data)) };
  }
  getDraft(key: string): BookDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `book:${key}`); if (raw === null) return null; const draft = bookDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, draft: BookDraft): BookDraftView {
    draft = bookDraftSchema.parse(draft); const scope = this.scope(), previous = this.getDraft(key), coordinator = this.dependencies.coordinator, operation = previous?.operationId ? coordinator?.getOperation(scope, previous.operationId) : null;
    if (operation && !operationIsFinal(operation)) return assetError('DRAFT_OPERATION_PENDING', '原账本操作尚未核清，请查看原操作'); if (coordinator?.store.find(scope, draft.requestId)) return assetError('DRAFT_ALREADY_SUBMITTED', '此草稿已提交，请查看原操作');
    this.dependencies.repository.saveDraft(scope, `book:${key}`, { ...draft, input: { ...draft.input } }); return { draft, operationId: null };
  }
  async list(input: BookListInput = {}): Promise<BookListView> {
    const options = bookListSchema.parse(input), scope = this.dependencies.connection.scope() ?? assetError('CONNECTION_REQUIRED', '请先连接钱迹'), { cache, repository } = this.dependencies;
    let source = cache.read(scope, bookListKey), problem: Problem | undefined;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.stale && connected) {
      const key = JSON.stringify([scope.uid, scope.connectionEpoch]); let pending = this.#pending.get(key);
      if (!pending) { pending = refreshBooks(this.dependencies, scope); this.#pending.set(key, pending); }
      try { await pending; } catch (error) { problem = safeProblem(error); } finally { if (this.#pending.get(key) === pending) this.#pending.delete(key); }
      source = cache.read(scope, bookListKey);
    }
    const items = source.items.map((item) => bookView(asBillObject(item.raw), scope.uid, this.dependencies.vipExpired?.() ?? false)).filter((item) => options.includeHidden || item.visible);
    return { items, freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
}
