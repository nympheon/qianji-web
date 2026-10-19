import {resourceExisted} from '../../operations/identity';
import type { MutationHandler, OperationContext, PreparedMutation, ItemUpdate } from '../../operations/contract';
import { asBillObject, numericText, type BillObject } from '../../shared/bill-wire';
import type { ActorScope } from '../../shared/model';
import { stringifyWire, wireId } from '../../shared/wire-json';
import { ResourceCache } from '../../storage/cache';
import type { ResourceRecord } from '../../storage/resources';
import { assetError } from '../assets/model';
import { billVersion, restoreBillInput } from '../ledger/write';
import { tagSubmitSchema, tagGroupSubmitSchema, tagArchiveSchema, tagDeleteSchema, tagOrderSchema } from './contract';
import { refreshTags, tagCatalogKey, tagView, tagGroupView } from './source';
function decode(prepared: PreparedMutation) { const p = asBillObject(prepared.payload), s = asBillObject(p.scope); if (typeof s.uid !== 'string' || typeof s.connectionEpoch !== 'string' || typeof p.logicalId !== 'string' || typeof p.kind !== 'string') return assetError('TAG_OPERATION_INVALID', '标签操作日志无法核对'); const scope: ActorScope = { uid: s.uid, connectionEpoch: s.connectionEpoch }; return { p, scope, logicalId: p.logicalId, kind: p.kind, id: typeof p.id === 'string' ? p.id : null, expected: asBillObject(p.expected), params: asBillObject(p.params) }; }
function remove(ctx: OperationContext, scope: ActorScope, records: { id: string; kind: 'tag' | 'tagGroup' }[]) { const dataset = ctx.repository.dataset(scope, 'tags'); if (!dataset) return assetError('DATASET_MISSING', '标签副本尚未准备'); ctx.repository.applyPage(scope, dataset.id, { upserts: [], deletes: [], resources: [], resourceDeletes: records, pageState: ctx.repository.syncState(scope, 'tags', dataset.id)?.pageState ?? null }, 'tags'); }
function exact(raw: BillObject, expected: BillObject, kind: string) { if (raw.name !== expected.name && expected.name !== undefined) return false; if (kind === 'group-submit') return true; const view = tagView(raw); return (expected.archived === undefined || view.archived === expected.archived) && (expected.groupId === undefined || view.groupId === expected.groupId) && (expected.color === undefined || (view.color?.toUpperCase() ?? null) === (typeof expected.color === 'string' ? expected.color.toUpperCase() : null)); }
export function createTagMutationHandler(_dependencies: { reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const scope = command.scope, input = restoreBillInput(command.input), rows = await refreshTags(ctx, scope), params: BillObject = { uid: scope.uid }, expected: BillObject = {}; let kind: string, id: string | null = null, noop = false, prior: ResourceRecord | undefined, ids: string[] = [];
      const find = (id: string, group: boolean) => rows.find((row) => row.id === id && row.kind === (group ? 'tagGroup' : 'tag')) ?? assetError('TAG_NOT_LOADED', '目标标签或分组已不存在');
      const version = (row: ResourceRecord, wanted: string) => { if (billVersion(asBillObject(row.raw)) !== wanted) return assetError('DRAFT_SOURCE_CHANGED', '标签资料已变化，请重新查看'); };
      if (command.action === 'tags.submitTag' || command.action === 'tags.submitGroup') {
        const isGroup = command.action === 'tags.submitGroup', value = isGroup ? tagGroupSubmitSchema.parse(input) : tagSubmitSchema.parse(input); kind = isGroup ? 'group-submit' : 'tag-submit';
        if (value.mode === 'edit') { id = value.id; prior = find(id, isGroup); version(prior, value.expectedVersion); params.did = id; }
        expected.name = value.name;
        if (!isGroup) { const tagInput = tagSubmitSchema.parse(input); if (tagInput.groupId) find(tagInput.groupId, true); expected.groupId = tagInput.groupId; if (tagInput.color !== null || tagInput.mode === 'edit') expected.color = tagInput.color; params.v = stringifyWire({ name: tagInput.name, ...(tagInput.groupId ? { groupid: tagInput.groupId } : {}), ...(tagInput.color ? { color: tagInput.color } : {}) }); }
        else params.v = value.name;
      } else if (command.action === 'tags.setArchived') {
        const value = tagArchiveSchema.parse(input); kind = 'archive'; id = value.id; prior = find(id, false); const view = tagView(asBillObject(prior.raw)); noop = view.archived === value.archived; expected.archived = value.archived; expected.name = view.name; params.did = id;
      } else if (command.action === 'tags.deleteTag' || command.action === 'tags.deleteGroup') {
        const value = tagDeleteSchema.parse(input), isGroup = command.action === 'tags.deleteGroup'; kind = isGroup ? 'group-delete' : 'tag-delete'; id = value.id; prior = find(id, isGroup); version(prior, value.expectedVersion); params.did = id;
      } else if (command.action === 'tags.reorderTags' || command.action === 'tags.reorderGroups') {
        const value = tagOrderSchema.parse(input), isGroup = command.action === 'tags.reorderGroups'; kind = isGroup ? 'group-order' : 'tag-order'; ids = value.ids; const selected = ids.map((id) => find(id, isGroup)); if (!isGroup && new Set(selected.map((row) => tagView(asBillObject(row.raw)).groupId)).size > 1) return assetError('TAG_ORDER_SCOPE_INVALID', '标签排序需属于同一分组'); params.v = JSON.stringify(ids);
      } else return assetError('TAG_ACTION_UNSUPPORTED', '标签动作尚未实现');
      const logicalId = `tag:${command.requestId}`, affectedIds = [id ? `${kind.startsWith('group') ? 'tag-group' : 'tag'}:${id}` : 'tag-catalog', ...ids.map((id) => `tag:${id}`)];
      return { payload: { scope: { ...scope }, logicalId, kind, id, expected, params, noop, prior: prior?.raw ?? null, ids }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['tags'] };
    },
    send: async (prepared, ctx) => { const { p, scope, kind, params } = decode(prepared); if (p.noop === true) return { ec: '200', httpStatus: 200, data: p.prior ?? null }; const op = kind === 'tag-submit' ? 'tag.submit' : kind === 'group-submit' ? 'tagGroup.submit' : kind === 'archive' ? 'tag.archive' : kind === 'tag-delete' ? 'tag.delete' : kind === 'group-delete' ? 'tagGroup.delete' : kind === 'tag-order' ? 'tag.reorder' : 'tagGroup.reorder'; return ctx.client.request(op, params, scope); },
    applyReceipt: (prepared, reply, ctx) => {
      const { scope, kind, expected, logicalId, id } = decode(prepared), cache = new ResourceCache(ctx.repository, ctx.clock);
      if (kind === 'tag-order' || kind === 'group-order') return { items: [{ id: logicalId, state: 'uncertain', error: { code: 'TAG_ORDER_CHECK', message: '排序已受理，需读取官方次序核对' } }] };
      if (kind === 'tag-delete' || kind === 'group-delete') {
        if (!id) return assetError('TAG_OPERATION_INVALID', '删除日志缺少ID');
        if (kind === 'group-delete') { const source = cache.read(scope, tagCatalogKey); const tags = source.items.filter((item) => item.kind === 'tag' && tagView(asBillObject(item.raw)).groupId === id).map((item) => ({ ...item, raw: { ...asBillObject(item.raw), groupid: null } })); if (tags.length) cache.confirmResources(scope, 'tags', tags); }
        remove(ctx, scope, [{ id, kind: kind === 'tag-delete' ? 'tag' : 'tagGroup' }]);
        return { items: [{ id: logicalId, state: 'succeeded' }] };
      }
      const raw = asBillObject(reply.data), isGroup = kind === 'group-submit', view = isGroup ? tagGroupView(raw) : tagView(raw), record: ResourceRecord = { id: view.id, kind: isGroup ? 'tagGroup' : 'tag', raw };
      if (id && view.id !== id || !exact(raw, expected, kind) || raw.userid != null && numericText(raw.userid, '') !== scope.uid || !id && resourceExisted(prepared,ctx.repository,scope,'tags',record.kind,view.id,ctx.validatingHistoricalReceipt)) return assetError('TAG_RECEIPT_INVALID', '官方标签回执与本次目标不符'); cache.confirmResources(scope, 'tags', [record]); const affectedIds = [...new Set([...prepared.affectedIds, `${record.kind}:${record.id}`])]; return { items: [{ id: logicalId, state: 'succeeded', affectedIds }], affectedIds, ...(!id ? { idMap: { [logicalId]: view.id } } : {}) };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] }; const { p, scope, kind, id, logicalId, expected } = decode(operation.prepared); if ((kind === 'tag-submit' || kind === 'group-submit') && !id) return { items: [] };
      const records = await refreshTags(ctx, scope), groups = kind.startsWith('group'), matching = records.find((row) => row.kind === (groups ? 'tagGroup' : 'tag') && row.id === id), items: ItemUpdate[] = [];
      if (kind.endsWith('delete')) { if (!matching && (kind !== 'group-delete' || records.filter((row) => row.kind === 'tag').every((row) => tagView(asBillObject(row.raw)).groupId !== id))) { items.push({ id: logicalId, state: 'succeeded' }); // Legacy journals waited for a bill rewrite that the native API never performs.
          if(kind==='tag-delete'&&operation.items.some(item=>item.id===`tag-ledger:${id}`))items.push({id:`tag-ledger:${id}`,state:'succeeded'}); } }
      else if (kind.endsWith('order') && Array.isArray(p.ids)) { const ids = p.ids.map((value) => wireId(value)), actual = records.filter((row) => row.kind === (groups ? 'tagGroup' : 'tag') && ids.includes(row.id)).sort((a, b) => Number(numericText(asBillObject(a.raw).sort, '0')) - Number(numericText(asBillObject(b.raw).sort, '0'))).map((row) => row.id); if (JSON.stringify(ids) === JSON.stringify(actual)) items.push({ id: logicalId, state: 'succeeded' }); }
      else if (matching && exact(asBillObject(matching.raw), expected, kind)) items.push({ id: logicalId, state: 'succeeded' }); return { items };
    },
  };
}
