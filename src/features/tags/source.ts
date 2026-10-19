import type { OperationContext } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject, numericText, type BillObject } from '../../shared/bill-wire';
import { wireId } from '../../shared/wire-json';
import { ResourceCache, type CacheKey } from '../../storage/cache';
import type { ResourceRecord } from '../../storage/resources';
import { assetError } from '../assets/model';
import { parseTagGroups } from '../sync/incremental';
import { billVersion } from '../ledger/write';
import type { TagView, TagGroupView } from './contract';
export const tagRowsKey:CacheKey={domain:'tags',queryKey:'rows:all',resourceKind:'tag'};
export const tagCatalogKey: CacheKey = { domain: 'tags', queryKey: 'catalog:all' };
export function tagView(raw: BillObject): TagView { const id = wireId(raw.id ?? null), status = numericText(raw.status, '1'); if (typeof raw.name !== 'string' || !['1', '2'].includes(status)) return assetError('TAG_RESPONSE_INVALID', '标签名称或状态无法核对'); return { id, name: raw.name, groupId: raw.groupid == null || raw.groupid === '' ? null : wireId(raw.groupid), color: typeof raw.color === 'string' && /^(?:[\da-f]{6}|[\da-f]{8})$/i.test(raw.color) ? raw.color : null, archived: status === '2', sort: Number(numericText(raw.sort, '0')), editVersion: billVersion(raw) }; }
export function tagGroupView(raw: BillObject): TagGroupView { if (typeof raw.name !== 'string') return assetError('TAG_GROUP_INVALID', '标签分组缺少名称'); return { id: wireId(raw.id ?? null), name: raw.name, sort: Number(numericText(raw.sort, '0')), editVersion: billVersion(raw) }; }
export async function refreshTags(ctx: Pick<OperationContext, 'repository' | 'clock' | 'client'>, scope: ActorScope): Promise<ResourceRecord[]> {
  const cache = new ResourceCache(ctx.repository, ctx.clock), stamp = cache.captureRead(scope, tagCatalogKey), reply = await ctx.client.request('tag.list', { uid: scope.uid, status: '-1', lasttime: '0' }, scope);
  if (reply.hasMore) return assetError('TAG_SOURCE_INCOMPLETE', '标签完整目录尚未返回'); const records = parseTagGroups(reply.data);
  if (records.length > 10000 || new Set(records.map((item) => `${item.kind}:${item.id}`)).size !== records.length) return assetError('TAG_SOURCE_INVALID', '标签目录重复或超过本次完整核对范围');
  for (const item of records) { const raw = asBillObject(item.raw); if (raw.userid != null && numericText(raw.userid, '') !== scope.uid) return assetError('TAG_SCOPE_INVALID', '标签来源包含其他账号资料'); if (item.kind === 'tag') tagView(raw); else tagGroupView(raw); }
  ctx.repository.transaction(() => {
    if (cache.applyRead(stamp, { items: records, complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '标签读取期间发生变化，请重新查看');
    const dataset = ctx.repository.dataset(scope, 'tags')!, returned = new Set(records.map((item) => `${item.kind}:${item.id}`)), missing = ctx.repository.sql.exec<{ id: string; kind: 'tag' | 'tagGroup' }>("SELECT id,kind FROM resources WHERE uid=? AND domain='tags' AND dataset_id=? AND kind IN ('tag','tagGroup')", scope.uid, dataset.id).toArray().filter((item) => !returned.has(`${item.kind}:${item.id}`));
    if (missing.length) ctx.repository.applyPage(scope, dataset.id, { upserts: [], deletes: [], resources: [], resourceDeletes: missing, pageState: ctx.repository.syncState(scope, 'tags', dataset.id)?.pageState ?? null }, 'tags');
  }); return records;
}
