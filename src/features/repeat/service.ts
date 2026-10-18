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
import { repeatDraftSchema, repeatQuerySchema, repeatPreviewSchema, type RepeatDraft, type RepeatDraftView, type RepeatListView, type RepeatPreviewInput, type RepeatQuery, type HolidayYears } from './contract';
import { holidayKey, holidayYears, refreshRepeats, repeatKey, repeatView } from './source';
import { previewRepeat } from './preview';
export class RepeatService {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dependencies: OperationContext & { connection: Pick<ConnectionService, 'scope'>; cache: ResourceCache; coordinator?: Coordinator }) {}
  private scope() { const scope = this.dependencies.connection.scope(); if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
  private async coalesce(key: string, run: () => Promise<unknown>) { const id = JSON.stringify([this.scope(), key]); let task = this.#pending.get(id); if (!task) { task = run(); this.#pending.set(id, task); } try { return await task; } finally { if (this.#pending.get(id) === task) this.#pending.delete(id); } }
  async list(input: RepeatQuery = {}): Promise<RepeatListView> {
    const query = repeatQuerySchema.parse(input), scope = this.scope(), { cache, repository } = this.dependencies, key = repeatKey(query); let source = cache.read(scope, key), problem;
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    if (source.needsValidation && connected) { try { await this.coalesce(key.queryKey, () => refreshRepeats(this.dependencies, scope, query)); } catch (error) { problem = safeProblem(error); } source = cache.read(scope, key); }
    return { items: source.items.map((row) => repeatView(asBillObject(row.raw))).filter((row) => (!query.statuses || query.statuses.includes(row.status)) && (!query.types || query.types.includes(row.type))), freshness: { revision: source.revision, complete: source.complete, stale: source.stale || !connected || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  async preview(input: RepeatPreviewInput) {
    const value = repeatPreviewSchema.parse(input); if (value.fields.repeat.type !== 'workday') return previewRepeat(value);
    const scope = this.scope(), { cache } = this.dependencies, maps: HolidayYears = {}, attempted = new Set<number>(); let needed = Number(new Date(Date.parse(value.fields.startDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 4));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempted.has(needed) || needed < 1 || needed > 9999) throw new DomainError('HOLIDAYS_MISSING', '所需年份没有可核对的官方节假日数据'); attempted.add(needed); const key = holidayKey([needed]); let source = cache.read(scope, key);
      if (source.needsValidation) { const year = needed; await this.coalesce(key.queryKey, async () => { const stamp = cache.captureRead(scope, key), reply = await this.dependencies.client.request('repeat.holidays', { uid: scope.uid, years: String(year) }, scope), all = holidayYears(reply.data), data = { years: { [String(year)]: all[String(year)] ?? {} } }; if (cache.applyRead(stamp, { items: [{ id: key.queryKey, kind: 'holiday', raw: data }], complete: true }) !== 'applied') throw new DomainError('SOURCE_SUPERSEDED', '节假日读取期间发生变化'); }); source = cache.read(scope, key); }
      Object.assign(maps, source.items[0] ? holidayYears(source.items[0].raw) : {});
      try { return previewRepeat(value, maps); } catch (error) { const missing = error instanceof DomainError && error.code === 'HOLIDAYS_MISSING' ? /缺少(\d{4})年/.exec(error.detail) : null; if (!missing || attempted.has(Number(missing[1]))) throw error; needed = Number(missing[1]); }
    }
    throw new DomainError('HOLIDAYS_MISSING', '本次预览需要更多年度数据，请缩小预览范围');
  }

  mutate(action: RepeatDraft['action'], input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) throw new DomainError('ACTION_UNAVAILABLE', '周期任务写入尚未准备'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  getDraft(key: string): RepeatDraftView | null { const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `repeat:${key}`); if (raw === null) return null; const draft = repeatDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId); return { draft, operationId: operation?.id ?? null }; }
  saveDraft(key: string, input: RepeatDraft): RepeatDraftView { const draft = repeatDraftSchema.parse(input), scope = this.scope(), previous = this.getDraft(key), operation = previous?.operationId ? this.dependencies.coordinator?.getOperation(scope, previous.operationId) : null; if (operation && !operationIsFinal(operation)) throw new DomainError('DRAFT_OPERATION_PENDING', '原周期任务操作尚未核清，请保留原草稿'); if (this.dependencies.coordinator?.store.find(scope, draft.requestId)) throw new DomainError('DRAFT_ALREADY_SUBMITTED', '原草稿已提交，请查看原操作'); this.dependencies.repository.saveDraft(scope, `repeat:${key}`, draft); return { draft, operationId: null }; }
}
