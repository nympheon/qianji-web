import type { Repository } from '../../storage/database';
import type { ResourceCache, CacheKey, CacheView } from '../../storage/cache';
import type { QianjiClient } from '../../protocol/client';
import type { ActorScope, Clock } from '../../shared/model';
import type { ConnectionService } from '../connection/service';
import { asBillObject, moneyText, numericText, positiveBillId } from '../../shared/bill-wire';
import type { ResourceRecord } from '../../storage/resources';
import { assetListSchema, assetTrendSchema, type AssetListInput, type AssetListView, type AssetView, type AssetTrendInput, type AssetTrendView, type AssetTypesView, type AssetSubmitInput, type BalanceAdjustmentInput, type DebtFinishInput } from './contract';
import { assetError, assetView, validateAsset } from './model';
import { summarizeAssets } from './summary';
import { assetGroupKey, loadGroupRecords, missingGroups } from './groups';
import { billVersion } from '../ledger/write';
import type { AssetGroupsView } from './contract';
import type { Coordinator } from '../../actor/coordinator';
import type { WireJson } from '../../shared/wire-json';
import { assetDeleteDependencies, assetDeletionImpact } from './deletion';
import { assetDraftSchema, type AssetDraft, type AssetDraftView } from './contract';
import { restoreBillInput } from '../ledger/write';
import { operationIsFinal } from '../../operations/contract';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
import type { AssetDeleteInput, AssetGroupAddInput, AssetGroupDeleteInput, AssetGroupRemoveInput, AssetGroupReorderInput, AssetGroupSubmitInput, AssetReorderInput, AssetSummaryView, AssetVisibleInput } from './contract';

export const assetListKey = (status = 0): CacheKey => ({ domain: 'assets', queryKey: `asset:list:${status}` });
export const assetInfoKey = (id: string): CacheKey => ({ domain: 'assets', queryKey: `asset:info:${id}`, resourceKind: 'asset' });
export interface AssetDependencies { repository: Repository; cache: ResourceCache; client: QianjiClient; clock: Clock; connection: Pick<ConnectionService, 'scope'>; coordinator?: Coordinator; baseCurrency?: () => string }
export class AssetService {
  readonly #pending = new Map<string, Promise<void>>();
  constructor(private readonly dependencies: AssetDependencies) {}
  private mutate(action: string, input: WireJson, meta: { requestId: string }) { if (!this.dependencies.coordinator) return assetError('ACTION_UNAVAILABLE', '资产写操作尚未启用'); return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() }); }
  submit(input: AssetSubmitInput, meta: { requestId: string }) { return this.mutate('assets.submit', input, meta); }
  adjustBalance(input: BalanceAdjustmentInput, meta: { requestId: string }) { return this.mutate('assets.adjustBalance', input, meta); }
  setFinished(input: DebtFinishInput, meta: { requestId: string }) { return this.mutate('assets.setFinished', input, meta); }
  setVisible(input: AssetVisibleInput, meta: { requestId: string }) { return this.mutate('assets.setVisible', input, meta); }
  reorder(input: AssetReorderInput, meta: { requestId: string }) { return this.mutate('assets.reorder', input, meta); }
  remove(input: AssetDeleteInput, meta: { requestId: string }) { return this.mutate('assets.delete', input, meta); }
  submitGroup(input: AssetGroupSubmitInput, meta: { requestId: string }) { return this.mutate('assets.groups.submit', input, meta); }
  removeGroup(input: AssetGroupDeleteInput, meta: { requestId: string }) { return this.mutate('assets.groups.delete', input, meta); }
  reorderGroups(input: AssetGroupReorderInput, meta: { requestId: string }) { return this.mutate('assets.groups.reorder', input, meta); }
  addToGroup(input: AssetGroupAddInput, meta: { requestId: string }) { return this.mutate('assets.groups.add', input, meta); }
  removeFromGroup(input: AssetGroupRemoveInput, meta: { requestId: string }) { return this.mutate('assets.groups.remove', input, meta); }
  async summary(input: Pick<AssetListInput, 'status' | 'includeInstallments'> = {}): Promise<AssetSummaryView> { const view = await this.list({ ...input, limit: 1 }); return { summary: view.summary, freshness: view.freshness, ...(view.problem ? { problem: view.problem } : {}) }; }
  getDraft(key: string): AssetDraftView | null {
    const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `asset:${key}`); if (raw === null) return null;
    const draft = assetDraftSchema.parse(restoreBillInput(raw)), operation = this.dependencies.coordinator?.store.find(scope, draft.requestId);
    return { draft, operationId: operation?.id ?? null };
  }
  saveDraft(key: string, draft: AssetDraft): AssetDraftView {
    draft = assetDraftSchema.parse(draft); const scope = this.scope(), previous = this.getDraft(key), coordinator = this.dependencies.coordinator;
    const operation = previous?.operationId ? coordinator?.getOperation(scope, previous.operationId) : null;
    if (operation && !operationIsFinal(operation)) return assetError('DRAFT_OPERATION_PENDING', '该草稿已有未核清的资产操作，请查看原操作');
    if (coordinator?.store.find(scope, draft.requestId)) return assetError('DRAFT_ALREADY_SUBMITTED', '该草稿已提交，请先查看原操作');
    this.dependencies.repository.saveDraft(scope, `asset:${key}`, { ...draft, input: { ...draft.input } }); return { draft, operationId: null };
  }
  async detail(id: string) {
    const source = await this.resources(assetInfoKey(id), async (scope) => { const reply = await this.dependencies.client.request('asset.info', { uid: scope.uid, did: id }, scope); return [{ id, kind: 'asset', raw: validateAsset(asBillObject(reply.data), scope, id) }]; });
    return { asset: source.items[0] ? assetView(asBillObject(source.items[0].raw), this.dependencies.baseCurrency?.() ?? 'CNY') : null, freshness: this.freshness(source), ...(source.problem ? { problem: source.problem } : {}) };
  }
  async checkDelete(id: string) {
    const scope = this.scope(), row = this.dependencies.repository.readResources(scope, 'asset', { domain: 'assets', ids: [id] }).items[0]; if (!row) return assetError('ASSET_NOT_LOADED', '请先载入资产');
    const raw = asBillObject(row.raw), check = await assetDeleteDependencies(this.dependencies.client, scope, id, numericText(raw.type, '-1'));
    const impact = assetDeletionImpact({ repository: this.dependencies.repository }, scope, id);
    return { id, ...check, blocked: check.installCount > 0 || check.repeatCount > 0, deleteBillIds: impact.filter((item) => item.kind === 'delete').map((item) => item.id), detachBillIds: impact.filter((item) => item.kind === 'detach').map((item) => item.id), expectedVersion: billVersion(raw) };
  }
  private freshness(source: CacheView & { problem?: Problem }) { return { revision: source.revision, complete: source.complete, stale: source.stale || !this.connected() || !!source.problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }; }
  private async resources(key: CacheKey, load: (scope: ActorScope) => Promise<ResourceRecord[]>): Promise<CacheView & { problem?: Problem }> {
    const scope = this.scope(), { cache } = this.dependencies;
    let current = cache.read(scope, key); if (!current.needsValidation || !this.connected()) return current;
    const fingerprint = JSON.stringify([scope.uid, scope.connectionEpoch, key.queryKey]), pending = this.#pending.get(fingerprint);
    if (pending) { try { await pending; return cache.read(scope, key); } catch (error) { return { ...cache.read(scope, key), problem: safeProblem(error) }; } }
    const request = (async () => { const stamp = cache.captureRead(scope, key), items = await load(scope), deletes = key.queryKey === assetGroupKey.queryKey ? missingGroups(this.dependencies.repository, scope, items) : undefined; if (cache.applyRead(stamp, { items, complete: true, ...(deletes ? { deletes } : {}) }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '资源读取期间发生变化，请重新查看'); })();
    this.#pending.set(fingerprint, request); try { await request; } catch (error) { return { ...cache.read(scope, key), problem: safeProblem(error) }; } finally { this.#pending.delete(fingerprint); }
    current = cache.read(scope, key); return current;
  }
  async types(): Promise<AssetTypesView> {
    const key: CacheKey = { domain: 'catalogs', queryKey: 'asset:types', resourceKind: 'assetType' };
    const source = await this.resources(key, async (scope) => {
      const reply = await this.dependencies.client.request('asset.types', { uid: scope.uid }, scope);
      if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 500) return assetError('ASSET_TYPES_INVALID', '资产类型列表无法识别或尚未完整返回');
      let group = ''; const items: ResourceRecord[] = [];
      for (const value of reply.data) {
        const row = asBillObject(value);
        if (row.type == null) { group = typeof row.name === 'string' ? row.name : ''; continue; }
        const raw = asBillObject(row.type), type = Number(numericText(raw.type, '-1')), subtype = Number(numericText(raw.stype, '-1'));
        if (!Number.isSafeInteger(type) || !Number.isSafeInteger(subtype) || type < 0 || subtype < 0) return assetError('ASSET_TYPES_INVALID', '资产类型编码无效');
        items.push({ id: `${type}:${subtype}`, kind: 'assetType', raw: { groupName: group, type: raw } });
      }
      return items;
    });
    return { items: source.items.map((item) => { const row = asBillObject(item.raw), raw = asBillObject(row.type); return { type: Number(numericText(raw.type, '-1')), subtype: Number(numericText(raw.stype, '-1')), name: typeof raw.name === 'string' ? raw.name : '', group: typeof row.groupName === 'string' ? row.groupName : '', icon: typeof raw.icon === 'string' ? raw.icon : '', color: typeof raw.c === 'string' ? raw.c : '' }; }), freshness: this.freshness(source), ...(source.problem ? { problem: source.problem } : {}) };
  }
  async groups(): Promise<AssetGroupsView> {
    const source = await this.resources(assetGroupKey, (scope) => loadGroupRecords(this.dependencies.client, scope));
    return { items: source.items.map((item) => { const raw = asBillObject(item.raw); return { id: item.id, name: String(raw.name), sort: Number(numericText(raw.sort, '0')), editVersion: billVersion(raw) }; }), freshness: this.freshness(source), ...(source.problem ? { problem: source.problem } : {}) };
  }
  async trend(input: AssetTrendInput): Promise<AssetTrendView> {
    input = assetTrendSchema.parse(input);
    const key: CacheKey = { domain: 'assets', queryKey: `asset:trend:${input.id}:${input.fromSec}:${input.toSec}`, resourceKind: 'assetSnapshot' };
    const source = await this.resources(key, async (scope) => {
      const reply = await this.dependencies.client.request('asset.trend', { uid: scope.uid, did: input.id, flts: JSON.stringify({ date: `${input.fromSec},${input.toSec}` }) }, scope);
      if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 2000) return assetError('ASSET_TREND_INVALID', '官方历史资产快照结构或数量无法核对');
      return reply.data.map((value) => { const raw = asBillObject(value), id = numericText(raw.dataid, ''), time = Number(numericText(raw.time, '-1'));
        if (!id || numericText(raw.assetid, '') !== input.id || !Number.isSafeInteger(time) || time < input.fromSec || time > input.toSec || raw.userid !== undefined && numericText(raw.userid, '') !== scope.uid) return assetError('ASSET_TREND_INVALID', '资产历史快照与本次范围不匹配');
        moneyText(raw.value); return { id, kind: 'assetSnapshot', raw };
      });
    });
    const scope = this.scope(), raw = this.dependencies.repository.readResources(scope, 'asset', { domain: 'assets', ids: [input.id] }).items[0];
    const currency = raw ? assetView(asBillObject(raw.raw), this.dependencies.baseCurrency?.() ?? 'CNY').currency : null;
    return { id: input.id, currency: currency ?? '', points: source.items.map((item) => { const raw = asBillObject(item.raw); return { id: item.id, timeSec: Number(numericText(raw.time, '0')), money: moneyText(raw.value) }; }).sort((a, b) => a.timeSec - b.timeSec), freshness: { ...this.freshness(source), complete: source.complete && currency !== null }, ...(source.problem ? { problem: source.problem } : {}) };
  }
  private scope() { const scope = this.dependencies.connection.scope(); if (!scope) return assetError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
  private connected() { return this.dependencies.repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected'; }
  private async refreshList(scope: ActorScope, status: number) {
    const { cache, client } = this.dependencies, key = assetListKey(status), fingerprint = JSON.stringify([scope.uid, scope.connectionEpoch, key.queryKey]);
    const pending = this.#pending.get(fingerprint); if (pending) return pending;
    const request = (async () => {
      const stamp = cache.captureRead(scope, key), reply = await client.request('asset.list', { uid: scope.uid, status }, scope), data = asBillObject(reply.data);
      if (!Array.isArray(data.list) || data.groups != null && !Array.isArray(data.groups) || data.list.length > 5000 || Array.isArray(data.groups) && data.groups.length > 1000) return assetError('ASSET_LIST_INVALID', '资产列表结构或数量无法核对');
      const items: ResourceRecord[] = data.list.map((value) => { const raw = validateAsset(asBillObject(value), scope); return { id: positiveBillId(raw.id)!, kind: 'asset', raw }; });
      for (const value of Array.isArray(data.groups) ? data.groups : []) { const raw = asBillObject(value), id = numericText(raw.groupid, ''); if (!id) return assetError('ASSET_GROUP_INVALID', '资产分组缺少ID'); items.push({ id, kind: 'assetGroup', raw }); }
      if (new Set(items.map((item) => JSON.stringify([item.kind, item.id]))).size !== items.length) return assetError('ASSET_LIST_INVALID', '资产列表包含重复ID');
      if (cache.applyRead(stamp, { items, complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '资产读取期间发生变化，请重新查看');
    })();
    this.#pending.set(fingerprint, request); try { await request; } finally { this.#pending.delete(fingerprint); }
  }
  async list(input: AssetListInput = {}, force = false): Promise<AssetListView> {
    const options = assetListSchema.parse(input), scope = this.scope(), { cache } = this.dependencies, key = assetListKey(options.status);
    if (force && !this.connected()) return assetError('CONNECTION_REQUIRED', '核对资产写入前需要有效连接');
    let source = cache.read(scope, key);
    let problem: Problem | undefined;
    if ((source.needsValidation || force) && this.connected()) { try { await this.refreshList(scope, options.status); } catch (error) { problem = safeProblem(error); } source = cache.read(scope, key); }
    const fingerprint = JSON.stringify([scope.uid, scope.connectionEpoch, options.status, options.limit, options.includeInstallments, source.revision]);
    let offset = 0;
    if (options.cursor) {
      try { const value = JSON.parse(atob(options.cursor)) as { key: string; offset: number }; if (value.key !== fingerprint || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error(); offset = value.offset; }
      catch { return assetError('PAGE_CHANGED', '资产列表已变化，请从第一页重新读取'); }
    }
    const assets = source.items.filter((item) => item.kind === 'asset').map((item) => asBillObject(item.raw)), base = this.dependencies.baseCurrency?.() ?? 'CNY';
    const summary = summarizeAssets(assets, options.includeInstallments, base);
    return { items: assets.slice(offset, offset + options.limit).map((raw) => assetView(raw, base)), groups: source.items.filter((item) => item.kind === 'assetGroup').map((item) => { const raw = asBillObject(item.raw); return { id: item.id, name: typeof raw.name === 'string' ? raw.name : '', sort: Number(numericText(raw.sort, '0')) }; }), summary,
      nextCursor: assets.length > offset + options.limit ? btoa(JSON.stringify({ key: fingerprint, offset: offset + options.limit })) : null,
      freshness: { revision: source.revision, complete: source.complete && summary.complete, stale: source.stale || !this.connected() || !summary.complete || !!problem, syncedAt: source.validatedAt === null ? null : new Date(source.validatedAt).toISOString() }, ...(problem ? { problem } : {}) };
  }
  async refreshInfo(id: string, client = this.dependencies.client): Promise<AssetView> {
    const scope = this.scope(), { cache } = this.dependencies, key = assetInfoKey(id), stamp = cache.captureRead(scope, key);
    const reply = await client.request('asset.info', { uid: scope.uid, did: id }, scope), raw = validateAsset(asBillObject(reply.data), scope, id);
    if (cache.applyRead(stamp, { items: [{ id, kind: 'asset', raw }], complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '资产读取期间发生变化，请稍后重新查看');
    return assetView(raw, this.dependencies.baseCurrency?.() ?? 'CNY');
  }
}
