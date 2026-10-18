import type { MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import { asBillObject, billExtra, moneyText, numericText, positiveBillId } from '../../shared/bill-wire';
import { stringifyWire } from '../../shared/wire-json';
import { restoreBillInput } from '../ledger/write';
import { assetDeleteSchema, assetReorderSchema, assetVisibleSchema, debtFinishSchema } from './contract';
import { prepareBalance } from './balance';
import { assetError, loadAsset, validateAsset } from './model';
import { currentFinished, ensureDebtAsset, readCurrentAsset } from './finish';
import { ResourceCache } from '../../storage/cache';
import type { ActorScope } from '../../shared/model';
import { compareMoney } from '../../shared/numbers';
import { projectBill } from '../sync/incremental';
import { assetMatchesIntent, prepareAssetSubmit } from './submit';
import { billVersion } from '../ledger/write';
import { LosslessNumber } from 'lossless-json';
import { assetDeleteDependencies, assetDeletionImpact } from './deletion';
import { AssetService } from './service';

function decode(prepared: PreparedMutation) {
  const p = asBillObject(prepared.payload), rawScope = asBillObject(p.scope);
  if (typeof p.id !== 'string' || typeof p.logicalId !== 'string' || !['balance', 'submit', 'finish', 'visible', 'reorder', 'delete'].includes(String(p.kind)) || typeof rawScope.uid !== 'string' || typeof rawScope.connectionEpoch !== 'string') return assetError('ASSET_OPERATION_INVALID', '资产操作日志无效');
  const scope: ActorScope = { uid: rawScope.uid, connectionEpoch: rawScope.connectionEpoch };
  return { scope, id: p.id, logicalId: p.logicalId, kind: p.kind, params: asBillObject(p.params), raw: asBillObject(p.raw), noop: p.noop === true, recordDifference: p.recordDifference === true, create: p.create === true, desired: p.desired, delta: p.delta, difference: p.difference, impact: p.impact, order: p.order, preparedAt: numericText(p.preparedAt, '0') };
}
export function createAssetMutationHandler(dependencies: { reconcileLedger?: (ctx: OperationContext) => Promise<boolean>; ensureTypes?:()=>Promise<unknown> } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const scope = command.scope, logicalId = `asset:${command.requestId}`;
      if (command.action === 'assets.submit') {
        if(asBillObject(command.input).mode==='create')await dependencies.ensureTypes?.();
        const value = prepareAssetSubmit(command, ctx), id = numericText(value.raw.id, '-1'), affectedIds = [value.create ? `asset-new:${command.requestId}` : `asset:${id}`];
        return { payload: { scope: { ...scope }, id, logicalId, kind: 'submit', raw: value.raw, create: value.create, params: { uid: scope.uid, v: stringifyWire(value.raw) } }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['assets'] };
      }
      if (command.action === 'assets.delete') {
        const input = assetDeleteSchema.parse(restoreBillInput(command.input)), raw = loadAsset(ctx, scope, input.id);
        if (billVersion(raw) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '资产已变化，请重新核对删除影响');
        if (numericText(raw.type, '') === '6') return assetError('ASSET_WRAPPER_UNSUPPORTED', '汇总包装项不能直接删除');
        const check = await assetDeleteDependencies(ctx.client, scope, input.id, numericText(raw.type, '-1'));
        if (check.installCount || check.repeatCount) return assetError('ASSET_IN_USE', '该资产仍被周期账单或分期使用，请先处理这些关联');
        const impact = assetDeletionImpact(ctx, scope, input.id), affectedIds = [`asset:${input.id}`, ...impact.map((item) => item.id)];
        return { payload: { scope: { ...scope }, id: input.id, logicalId, kind: 'delete', raw, params: { uid: scope.uid, did: input.id }, impact: impact.map((item) => ({ ...item })), preparedAt: String(ctx.clock.nowMs()) },
          items: [{ id: logicalId, affectedIds }, ...(impact.length ? [{ id: `asset-ledger:${input.id}`, affectedIds: impact.map((item) => item.id) }] : [])], affectedIds, affectedDomains: impact.length ? ['assets', 'ledger'] : ['assets'] };
      }
      if (command.action === 'assets.reorder') {
        const input = assetReorderSchema.parse(restoreBillInput(command.input));
        if (new Set(input.ids).size !== input.ids.length) return assetError('DUPLICATE_ASSET', '排序资产不能重复');
        input.ids.forEach((id) => loadAsset(ctx, scope, id)); const affectedIds = input.ids.map((id) => `asset:${id}`);
        return { payload: { scope: { ...scope }, id: 'order', logicalId, kind: 'reorder', raw: {}, params: { uid: scope.uid, v: stringifyWire(input.ids.map((id) => new LosslessNumber(id))) }, order: input.ids }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['assets'] };
      }
      if (command.action === 'assets.adjustBalance') {
        const balance = prepareBalance(command, ctx), affectedIds = [`asset:${balance.input.id}`];
        return { payload: { scope: { ...scope }, id: balance.input.id, logicalId, kind: 'balance', raw: balance.raw, params: { ...balance.params, v: stringifyWire(balance.raw), ...(balance.params.diffparams ? { diffparams: stringifyWire(balance.params.diffparams) } : {}) }, delta: balance.delta, difference: balance.params.diffparams ?? null, recordDifference: balance.input.recordDifference }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: balance.input.recordDifference ? ['assets', 'ledger'] : ['assets'] };
      }
      if (!['assets.setFinished', 'assets.setVisible'].includes(command.action)) return assetError('ASSET_ACTION_UNSUPPORTED', '资产动作尚未实现');
      const finish = command.action === 'assets.setFinished', input = finish ? debtFinishSchema.parse(restoreBillInput(command.input)) : assetVisibleSchema.parse(restoreBillInput(command.input)), raw = await readCurrentAsset(ctx, scope, input.id);
      if (finish) ensureDebtAsset(numericText(raw.type, '-1'), numericText(raw.status, '0'));
      else if (['5', '6'].includes(numericText(raw.type, ''))) return assetError('ASSET_VISIBILITY_TYPE_UNSUPPORTED', '借贷与汇总项使用其原生状态操作');
      const desired = 'finished' in input ? input.finished : input.visible, noop = (finish ? currentFinished(raw) : numericText(raw.status, '0') !== '2') === desired;
      const affectedIds = [`asset:${input.id}`];
      return { payload: { scope: { ...scope }, id: input.id, logicalId, kind: finish ? 'finish' : 'visible', raw, params: { uid: scope.uid, did: input.id, ...('date' in input && input.date ? { v: input.date } : {}) }, desired, noop }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: noop ? [] : ['assets'] };
    },
    send: async (prepared, ctx) => {
      const p = decode(prepared);
      if (p.noop === true) return { ec: '200', httpStatus: 200, data: p.raw };
      const op = p.kind === 'balance' || p.kind === 'submit' ? 'asset.submit' : p.kind === 'finish' ? 'asset.finish' : p.kind === 'visible' ? 'asset.visible' : p.kind === 'delete' ? 'asset.delete' : 'asset.reorder';
      return ctx.client.request(op, p.params, p.scope);
    },
    applyReceipt: (prepared, reply, ctx) => {
      const p = decode(prepared), cache = new ResourceCache(ctx.repository, ctx.clock);
      if (p.kind === 'finish' || p.kind === 'visible') {
        if (p.noop !== true) return { items: [{ id: p.logicalId, state: 'uncertain', error: { code: 'ASSET_TARGET_CHECK', message: '结清请求已受理，需只读核对实际状态' } }] };
        cache.confirmResources(p.scope, 'assets', [{ id: p.id, kind: 'asset', raw: p.raw }]); return { items: [{ id: p.logicalId, state: 'succeeded' }] };
      }
      if (p.kind === 'reorder') return { items: [{ id: p.logicalId, state: 'uncertain', error: { code: 'ASSET_ORDER_CHECK', message: '排序已受理，需读取官方列表核对顺序' } }] };
      if (p.kind === 'delete') {
        if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 5000) return assetError('ASSET_RECEIPT_INVALID', '资产删除回执不是完整官方资产列表');
        const resources = reply.data.map((value) => { const raw = validateAsset(asBillObject(value), p.scope); const id = positiveBillId(raw.id)!; if (id === p.id) return assetError('ASSET_RECEIPT_INVALID', '删除回执仍包含被删除资产'); return { id, kind: 'asset' as const, raw }; });
        if (new Set(resources.map((item) => item.id)).size !== resources.length) return assetError('ASSET_RECEIPT_INVALID', '资产删除回执包含重复ID');
        const dataset = ctx.repository.dataset(p.scope, 'assets'); if (!dataset) return assetError('DATASET_MISSING', '资产数据集不存在');
        ctx.repository.applyPage(p.scope, dataset.id, { upserts: [], deletes: [], resources, resourceDeletes: [{ id: p.id, kind: 'asset' }], pageState: ctx.repository.syncState(p.scope, 'assets', dataset.id)?.pageState ?? null }, 'assets');
        return { items: [{ id: p.logicalId, state: 'succeeded' }] };
      }
      const data = asBillObject(reply.data), raw = validateAsset(asBillObject(data.asset), p.scope, p.create ? undefined : p.id);
      if (p.kind === 'submit') {
        if (!assetMatchesIntent(raw, p.raw) || data.bill != null) return assetError('ASSET_RECEIPT_INVALID', '资产资料回执与本次修改不一致');
        const id = positiveBillId(raw.id)!;
        if (p.create && ctx.repository.readResources(p.scope, 'asset', { domain: 'assets', ids: [id] }).items.length) return assetError('ASSET_NEW_ID_CONFLICT', '新增回执复用了已有资产ID，请核查原操作');
        cache.confirmResources(p.scope, 'assets', [{ id, kind: 'asset', raw }]);
        const affectedIds = [`asset:${id}`]; return { items: [{ id: p.logicalId, state: 'succeeded', affectedIds }], affectedIds, ...(p.create ? { idMap: { [p.logicalId]: id } } : {}) };
      }
      if (compareMoney(moneyText(raw.money), moneyText(p.raw.money)) !== 0) return assetError('ASSET_RECEIPT_INVALID', '官方余额与本次目标不匹配');
      const bill = data.bill == null ? null : projectBill(data.bill);
      if (p.recordDifference === true && !bill || p.recordDifference !== true && bill) return assetError('ASSET_DIFFERENCE_RECEIPT_INVALID', '差额账单回执与选择不一致');
      if (bill && (positiveBillId(asBillObject(bill.raw).assetid) !== p.id || numericText(asBillObject(bill.raw).userid, '') !== p.scope.uid)) return assetError('ASSET_DIFFERENCE_RECEIPT_INVALID', '差额账单不属于当前资产或用户');
      if (bill) {
        const source = asBillObject(bill.raw), extra = billExtra(source), curr = extra.curr == null ? null : asBillObject(extra.curr), delta = moneyText(p.delta), positive = compareMoney(delta, '0') > 0;
        const actual = curr && typeof curr.ts === 'string' && curr.ts ? moneyText(curr.tv) : bill.money, expected = positive ? delta : delta.slice(1), difference = asBillObject(p.difference);
        if (bill.type !== (positive ? 1 : 0) || compareMoney(actual, expected) !== 0 || numericText(source.cateid, '') !== numericText(difference.cateid, '') || numericText(extra.flag, '0') !== numericText(difference.billflag, '0') || difference.remark !== undefined && source.remark !== difference.remark) return assetError('ASSET_DIFFERENCE_RECEIPT_INVALID', '差额账单的金额、类型、分类或标记与本次选择不一致');
      }
      cache.confirmResources(p.scope, 'assets', [{ id: p.id, kind: 'asset', raw }]);
      if (bill) { const ledger = ctx.repository.dataset(p.scope, 'ledger'); if (!ledger) return assetError('DATASET_MISSING', '差额账单的数据集尚未准备'); ctx.repository.applyPage(p.scope, ledger.id, { upserts: [bill], deletes: [], resources: [], pageState: ctx.repository.syncState(p.scope, 'ledger', ledger.id)?.pageState ?? null }); }
      const affectedIds = [...prepared.affectedIds, ...(bill ? [bill.id] : [])]; return { items: [{ id: p.logicalId, state: 'succeeded', affectedIds }], affectedIds };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] }; const p = decode(operation.prepared);
      if (p.kind === 'reorder') {
        const service = new AssetService({ repository: ctx.repository, cache: new ResourceCache(ctx.repository, ctx.clock), client: ctx.client, clock: ctx.clock, connection: { scope: () => p.scope } });
        const list = await service.list({ status: 0, limit: 200 }, true); if (list.problem) return { items: [] };
        const order = Array.isArray(p.order) ? p.order.map((value) => numericText(value, '')) : [];
        const observed = list.items.filter((item) => order.includes(item.id)).map((item) => item.id);
        return JSON.stringify(order) === JSON.stringify(observed) ? { items: [{ id: p.logicalId, state: 'succeeded' }] } : { items: [] };
      }
      if (p.kind === 'delete') {
        if (!await dependencies.reconcileLedger?.(ctx) || !Array.isArray(p.impact)) return { items: [] };
        const ledger = ctx.repository.dataset(p.scope, 'ledger'); if (!ledger?.complete || !ledger.validatedAt || Date.parse(ledger.validatedAt) < Number(p.preparedAt)) return { items: [] };
        const verified = p.impact.every((value) => { const item = asBillObject(value), row = ctx.repository.readBill(p.scope, numericText(item.id, '')); if (item.kind === 'delete') return !row; if (!row) return true; const raw = asBillObject(row.raw); return ['assetid', 'fromid', 'targetid'].every((key) => numericText(raw[key], '-1') !== p.id); });
        return verified ? { items: [{ id: `asset-ledger:${p.id}`, state: 'succeeded' }] } : { items: [] };
      }
      if (p.create) return { items: [] };
      const raw = await readCurrentAsset(ctx, p.scope, p.id);
      new ResourceCache(ctx.repository, ctx.clock).confirmResources(p.scope, 'assets', [{ id: p.id, kind: 'asset', raw }]);
      if (p.kind === 'finish' && currentFinished(raw) === p.desired) return { items: [{ id: p.logicalId, state: 'succeeded' }] };
      if (p.kind === 'visible' && (numericText(raw.status, '0') !== '2') === p.desired) return { items: [{ id: p.logicalId, state: 'succeeded' }] };
      if (p.kind === 'submit' && assetMatchesIntent(raw, p.raw)) return { items: [{ id: p.logicalId, state: 'succeeded' }] };
      // An equal balance alone cannot prove which change produced it or its optional difference bill.
      return { items: [] };
    },
  };
}
