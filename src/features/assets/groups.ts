import type { MutationHandler } from '../../operations/contract';
import { asBillObject, numericText, type BillObject } from '../../shared/bill-wire';
import { assetError, loadAsset } from './model';
import { assetGroupAddSchema, assetGroupDeleteSchema, assetGroupRemoveSchema, assetGroupReorderSchema, assetGroupSubmitSchema } from './contract';
import { billVersion, restoreBillInput } from '../ledger/write';
import { readCurrentAsset } from './finish';
import { ResourceCache, type CacheKey } from '../../storage/cache';
import { stringifyWire, type WireJson } from '../../shared/wire-json';
import type { QianjiClient } from '../../protocol/client';
import type { ActorScope } from '../../shared/model';
import { LosslessNumber } from 'lossless-json';
import type { ResourceRecord } from '../../storage/resources';
import type { Repository } from '../../storage/database';
export const assetGroupKey: CacheKey = { domain: 'assets', queryKey: 'asset:groups', resourceKind: 'assetGroup' };
export function groupRecord(value: WireJson, scope: ActorScope): ResourceRecord {
  const raw = asBillObject(value), id = numericText(raw.groupid, '');
  if (!id || typeof raw.name !== 'string' || raw.userid !== undefined && numericText(raw.userid, '') !== scope.uid) return assetError('ASSET_GROUP_INVALID', '分组回执的ID、名称或所属用户无法核对');
  return { id, kind: 'assetGroup', raw };
}
export async function loadGroupRecords(client: QianjiClient, scope: ActorScope): Promise<ResourceRecord[]> {
  const reply = await client.request('assetGroup.list', { uid: scope.uid }, scope);
  if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 1000) return assetError('ASSET_GROUP_INVALID', '分组列表无法核对或尚未完整返回');
  const records = reply.data.map((value) => groupRecord(value, scope));
  if (new Set(records.map((record) => record.id)).size !== records.length) return assetError('ASSET_GROUP_INVALID', '分组列表存在重复ID'); return records;
}
export function missingGroups(repository: Repository, scope: ActorScope, records: ResourceRecord[]): string[] {
  const returned = new Set(records.map((record) => record.id)), dataset = repository.dataset(scope, 'assets');
  return dataset ? repository.sql.exec<{ id: string }>("SELECT id FROM resources WHERE uid=? AND domain='assets' AND dataset_id=? AND kind='assetGroup'", scope.uid, dataset.id).toArray().map((row) => row.id).filter((id) => !returned.has(id)) : [];
}
export function createAssetGroupMutationHandler(): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const scope = command.scope, input = restoreBillInput(command.input), logicalId = `asset-group:${command.requestId}`;
      const known = (id: string, version?: string) => { const value = ctx.repository.readResources(scope, 'assetGroup', { domain: 'assets', ids: [id] }).items[0]; if (!value) return assetError('ASSET_GROUP_NOT_LOADED', '请先载入资产分组'); if (version && billVersion(value.raw) !== version) return assetError('DRAFT_SOURCE_CHANGED', '资产分组已变化，请重新查看'); return asBillObject(value.raw); };
      let params: BillObject = { uid: scope.uid }, kind = '', id: string | null = null, name: string | null = null, ids: string[] = [], desiredGroup: string | null = null, noop = false;
      const reads: BillObject[] = [];
      if (command.action === 'assets.groups.submit') { const value = assetGroupSubmitSchema.parse(input); kind = 'submit'; id = value.id; name = value.name; if (id) { known(id, value.expectedVersion); params.groupid = id; } params.name = name; }
      else if (command.action === 'assets.groups.delete') { const value = assetGroupDeleteSchema.parse(input); kind = 'delete'; id = value.id; known(id, value.expectedVersion); params.groupid = id; }
      else if (command.action === 'assets.groups.reorder') { const value = assetGroupReorderSchema.parse(input); kind = 'reorder'; ids = value.ids; if (new Set(ids).size !== ids.length) return assetError('DUPLICATE_GROUP', '分组排序不能重复'); ids.forEach((id) => known(id)); params.v = JSON.stringify(ids); }
      else if (command.action === 'assets.groups.add') { const value = assetGroupAddSchema.parse(input); kind = 'add'; id = value.groupId; known(id); ids = value.assetIds; desiredGroup = id; if (new Set(ids).size !== ids.length) return assetError('DUPLICATE_ASSET', '分组资产不能重复'); for (const id of ids) if (numericText(loadAsset(ctx, scope, id).type, '') === '6') return assetError('ASSET_WRAPPER_UNSUPPORTED', '汇总包装项不能加入分组'); const dataset = ctx.repository.dataset(scope, 'assets'); const startSort = ctx.repository.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM resources WHERE uid=? AND domain='assets' AND dataset_id=? AND kind='asset' AND json_extract(raw,'$.groupid')=?", scope.uid, dataset?.id ?? 'unloaded', id).one().n; params = { ...params, groupid: id, assetids: stringifyWire(ids.map((id) => new LosslessNumber(id))), startSort }; }
      else if (command.action === 'assets.groups.remove') { const value = assetGroupRemoveSchema.parse(input); kind = 'remove'; id = value.groupId; ids = [value.assetId]; const raw = await readCurrentAsset(ctx, scope, value.assetId); reads.push(raw); noop = numericText(raw.groupid, '') !== id; params.assetid = value.assetId; }
      else return assetError('ASSET_GROUP_ACTION_UNSUPPORTED', '分组动作不存在');
      const affectedIds = [...new Set([...(id ? [`asset-group:${id}`] : ['asset-groups']), ...(kind === 'add' || kind === 'remove' ? ids.map((id) => `asset:${id}`) : kind === 'reorder' ? ids.map((id) => `asset-group:${id}`) : [])])];
      return { payload: { scope: { ...scope }, logicalId, params, kind, id, ids, name, desiredGroup, noop, reads }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['assets'] };
    },
    send: async (prepared, ctx) => {
      const p = asBillObject(prepared.payload), scope = asBillObject(p.scope);
      if (p.noop === true) return { ec: '200', httpStatus: 200, data: null };
      const op = p.kind === 'submit' ? 'assetGroup.submit' : p.kind === 'delete' ? 'assetGroup.delete' : p.kind === 'add' ? 'assetGroup.add' : p.kind === 'remove' ? 'assetGroup.remove' : 'assetGroup.reorder';
      return ctx.client.request(op, asBillObject(p.params), { uid: String(scope.uid), connectionEpoch: String(scope.connectionEpoch) });
    },
    applyReceipt: (prepared, reply, ctx) => {
      const p = asBillObject(prepared.payload), rawScope = asBillObject(p.scope), scope = { uid: String(rawScope.uid), connectionEpoch: String(rawScope.connectionEpoch) }, id = String(p.logicalId), cache = new ResourceCache(ctx.repository, ctx.clock);
      if (p.noop === true) { if (Array.isArray(p.reads)) cache.confirmResources(scope, 'assets', p.reads.map((raw) => ({ id: numericText(asBillObject(raw).id, ''), kind: 'asset', raw }))); return { items: [{ id, state: 'succeeded' }] }; }
      if (p.kind !== 'submit') return { items: [{ id, state: 'uncertain', error: { code: 'ASSET_GROUP_CHECK', message: '分组操作已受理，需读取官方资料核对' } }] };
      const record = groupRecord(reply.data, scope), raw = asBillObject(record.raw);
      if (p.id !== null && record.id !== p.id || raw.name !== p.name || p.id === null && ctx.repository.readResources(scope, 'assetGroup', { domain: 'assets', ids: [record.id] }).items.length) return assetError('ASSET_GROUP_INVALID', '分组回执与本次创建或编辑不符');
      cache.confirmResources(scope, 'assets', [record]); const affectedIds = [`asset-group:${record.id}`];
      return { items: [{ id, state: 'succeeded', affectedIds }], affectedIds, ...(p.id === null ? { idMap: { [id]: record.id } } : {}) };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] }; const p = asBillObject(operation.prepared.payload), scope = operation.scope, cache = new ResourceCache(ctx.repository, ctx.clock), logicalId = String(p.logicalId);
      if (p.kind === 'add' || p.kind === 'remove') {
        if (!Array.isArray(p.ids)) return { items: [] };
        let verified = true;
        for (const value of p.ids) { const id = numericText(value, ''), raw = await readCurrentAsset(ctx, scope, id); cache.confirmResources(scope, 'assets', [{ id, kind: 'asset', raw }]); const group = numericText(raw.groupid, ''); if (p.kind === 'add' ? group !== p.desiredGroup : group === p.id) verified = false; }
        return verified ? { items: [{ id: logicalId, state: 'succeeded' }] } : { items: [] };
      }
      const stamp = cache.captureRead(scope, assetGroupKey), records = await loadGroupRecords(ctx.client, scope);
      const deletes = missingGroups(ctx.repository, scope, records);
      if (cache.applyRead(stamp, { items: records, complete: true, deletes }) !== 'applied') return { items: [] };
      if (p.kind === 'delete') return records.every((record) => record.id !== p.id) ? { items: [{ id: logicalId, state: 'succeeded' }] } : { items: [] };
      if (p.kind === 'submit' && p.id !== null) return records.some((record) => record.id === p.id && asBillObject(record.raw).name === p.name) ? { items: [{ id: logicalId, state: 'succeeded' }] } : { items: [] };
      if (p.kind === 'reorder' && Array.isArray(p.ids)) { const ids = p.ids.map((id) => numericText(id, '')), actual = records.filter((record) => ids.includes(record.id)).map((record) => record.id); if (JSON.stringify(ids) === JSON.stringify(actual)) return { items: [{ id: logicalId, state: 'succeeded' }] }; }
      return { items: [] };
    },
  };
}
