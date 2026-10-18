import { LosslessNumber } from 'lossless-json';
import type { MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject, numericText, type BillObject } from '../../shared/bill-wire';
import { stringifyWire } from '../../shared/wire-json';
import { DomainError } from '../../shared/errors';
import { compareMoney, addMoney } from '../../shared/numbers';
import { ResourceCache } from '../../storage/cache';
import { restoreBillInput } from '../ledger/write';
import { loadTransferAsset } from '../ledger/transfer';
import { assertImageReferences } from '../attachments/references';
import { planBindingSchema } from '../plans/contract';
import { planBindingGoal, validatePlanBinding } from '../plans/binding';
import { applyPlanBills } from '../plans/receipts';
import { repeatFieldsSchema, repeatWriteSchemas, type RepeatFields } from './contract';
import { refreshRepeats, repeatView } from './source';
import { repeatAmounts } from './preview';
const num = (value: string | null) => new LosslessNumber(value ?? '-1');
function decoded(prepared: PreparedMutation) { const p = asBillObject(prepared.payload), s = asBillObject(p.scope), scope: ActorScope = { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }; return { p, scope, id: String(p.id), logicalId: String(p.logicalId), kind: String(p.kind) }; }
function normalized(fields: RepeatFields) { const currency = repeatAmounts(fields).currency; return { ...fields, enteredMoney: addMoney(fields.enteredMoney), fee: addMoney(fields.fee), tagIds: [...fields.tagIds].sort(), repeat: { ...fields.repeat, values: fields.repeat.values.map((value) => fields.repeat.type === 'year' ? value.split('-').map(Number).join('-') : String(Number(value))).sort() }, currency: currency ? { ...currency, srcValue: addMoney(currency.srcValue), targetValue: addMoney(currency.targetValue), baseValue: addMoney(currency.baseValue) } : null }; }
function matches(raw: BillObject, fields: RepeatFields) { const actual = repeatView(raw).fields; return actual !== null && JSON.stringify(normalized(actual)) === JSON.stringify(normalized(fields)); }
function validateFields(ctx: OperationContext, scope: ActorScope, fields: RepeatFields, previous: RepeatFields | null, base: string, financialChange: boolean) {
  const amounts = repeatAmounts(fields); if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [fields.bookId] }).items.length) throw new DomainError('BOOK_NOT_LOADED', '请先载入周期任务使用的账本');
  if ([0, 1, 5].includes(fields.type)) { if (!fields.categoryId) throw new DomainError('CATEGORY_REQUIRED', '此周期账单需要分类'); const row = ctx.repository.readResources(scope, 'category', { domain: 'ledger', ids: [fields.categoryId] }).items[0], raw = row && asBillObject(row.raw); if (!raw || ![fields.bookId, '-1'].includes(numericText(raw.bookid, '')) || numericText(raw.type, '0') !== (fields.type === 1 ? '1' : '0')) throw new DomainError('CATEGORY_NOT_LOADED', '请载入当前账本和收支类型的分类'); }
  const from = fields.fromAssetId ? loadTransferAsset(ctx, scope, fields.fromAssetId, base) : null, target = fields.targetAssetId ? loadTransferAsset(ctx, scope, fields.targetAssetId, base) : null;
  if ([from, target].some((asset) => asset && [5, 6].includes(asset.type))) throw new DomainError('DEBT_ASSET_UNSUPPORTED', '普通周期任务不能使用借贷或汇总资产');
  if ([2, 3].includes(fields.type) && (!from || !target || from.id === target.id || fields.type === 3 && target.type !== 2)) throw new DomainError('REPEAT_ASSET_REQUIRED', '转账需选择不同资产，信用卡还款需选择信用卡作为目标');
  if (financialChange && !fields.currency && (from && from.currency !== base || target && target.currency !== base)) throw new DomainError('REPEAT_CURRENCY_REQUIRED', '请提供本次任务保存的历史币种金额');
  if (financialChange && fields.currency && (fields.currency.baseSymbol !== base || fields.currency.targetSymbol !== (target?.currency ?? from?.currency ?? base) || compareMoney(fields.currency.srcValue, fields.enteredMoney) !== 0 || [2, 3].includes(fields.type) && fields.currency.srcSymbol !== from?.currency)) throw new DomainError('REPEAT_CURRENCY_INVALID', '周期历史币种金额与资产、本位币或录入金额不匹配');
  for (const id of fields.tagIds) if (!ctx.repository.readResources(scope, 'tag', { domain: 'tags', ids: [id] }).items.length) throw new DomainError('TAG_NOT_LOADED', '请先载入所选标签'); assertImageReferences(ctx, scope, fields.images, previous?.images ?? []); return amounts;
}
function dataFor(fields: RepeatFields, old: BillObject = {}): BillObject {
  const amounts = repeatAmounts(fields), data: BillObject = { ...old, bookid: num(fields.bookId), cateid: fields.categoryId ? num(fields.categoryId) : 0, fromid: num(fields.fromAssetId), targetid: num(fields.targetAssetId), money: num(amounts.money), fee: num(amounts.fee), start: fields.startDate, time: fields.time, repeat: { type: fields.repeat.type, value: fields.repeat.values }, remark: fields.remark, billflag: (fields.countInStatistics ? 0 : 1) | (fields.countInBudget ? 0 : 2), images: fields.images, tags: fields.tagIds };
  if (fields.end) data.end = fields.end.kind === 'date' ? { date: fields.end.date, count: -1 } : { count: fields.end.count }; else delete data.end;
  if (amounts.currency) { const c = amounts.currency; data.curr = { ss: c.srcSymbol, sv: num(c.srcValue), ts: c.targetSymbol, tv: num(c.targetValue), bs: c.baseSymbol, bv: num(c.baseValue) }; } else delete data.curr; return data;
}
export function createRepeatMutationHandler(dependencies: { baseCurrency?: () => string; refreshLedger?: (ctx: OperationContext, scope: ActorScope) => Promise<boolean> } = {}): MutationHandler { return {
  prepare: async (command, ctx) => {
    if (!Object.hasOwn(repeatWriteSchemas, command.action)) throw new DomainError('ACTION_UNAVAILABLE', '此周期操作尚未开放');
    const action = command.action as keyof typeof repeatWriteSchemas, input = repeatWriteSchemas[action].parse(restoreBillInput(command.input)), scope = command.scope, logicalId = `repeat:${command.requestId}`, list = await refreshRepeats(ctx, scope), records = list.map((raw) => ({ raw, view: repeatView(raw) }));
    const id = 'id' in input ? input.id : 'planId' in input ? input.planId : '-1', record = records.find((record) => record.view.id === id), base = dependencies.baseCurrency?.() ?? 'CNY';
    let kind: string, noop = false, payload: BillObject = {}, affectedIds = [`repeat:${id}`], affectedDomains: import('../../storage/mirror').SyncDomain[] = ['repeat'];
    if (action === 'repeat.submit') {
      const value = repeatWriteSchemas['repeat.submit'].parse(input), previous = record?.view.fields ?? null; kind = 'submit';
      if (value.mode === 'edit' && (!record || !previous || record.view.editVersion !== value.expectedVersion)) throw new DomainError('DRAFT_SOURCE_CHANGED', '周期任务资料已变化或规则尚未核对，请重新查看');
      const fields = repeatFieldsSchema.parse(value.mode === 'create' ? value.fields : { ...previous, ...value.changes }), financialChange = value.mode === 'create' || !previous || (['type', 'enteredMoney', 'fee', 'fromAssetId', 'targetAssetId', 'currency'] as const).some((key) => JSON.stringify(normalized(fields)[key]) !== JSON.stringify(normalized(previous)[key])); validateFields(ctx, scope, fields, previous, base, financialChange);
      const raw: BillObject = record ? { ...record.raw } : { count: 0, status: 0, packid: 0, createtime: 0, updatetime: 0 }; raw.type = fields.type; raw.data = dataFor(fields, record ? asBillObject(record.raw.data) : {});
      if (fields.categoryId) { const category = ctx.repository.readResources(scope, 'category', { domain: 'ledger', ids: [fields.categoryId] }).items[0]; if (category) asBillObject(raw.data).category = category.raw; }
      payload = { raw, fields, create: value.mode === 'create', beforeIds: records.map((record) => record.view.id) }; affectedIds = [value.mode === 'create' ? 'repeat-catalog' : `repeat:${id}`]; affectedDomains = ['repeat', 'ledger', 'assets'];
    } else if (action === 'repeat.setPaused') {
      const value = repeatWriteSchemas['repeat.setPaused'].parse(input); kind = 'paused'; if (!record || ![0, 1].includes(record.view.status)) throw new DomainError('REPEAT_STATE_UNSUPPORTED', '仅执行中或已暂停任务支持启停'); noop = (record.view.status === 0) === value.paused; payload = { paused: value.paused, before: record.raw }; affectedDomains = ['repeat', 'ledger', 'assets'];
    } else if (action === 'repeat.setBillBinding') {
      const value = planBindingSchema.parse(input); kind = 'binding'; if (!record) throw new DomainError('REPEAT_NOT_LOADED', '周期任务已不存在'); if (!await dependencies.refreshLedger?.(ctx, scope)) throw new DomainError('LEDGER_SOURCE_NOT_READY', '请先完成最新账单同步再关联'); ctx.repository.assertScope(scope); noop = validatePlanBinding(ctx, scope, value, { id: record.view.id, packId: record.view.packId, allowedTypes: [record.view.type] }); payload = { binding: value }; affectedIds.push(value.billId); affectedDomains = ['repeat', 'ledger'];
    } else {
      const value = repeatWriteSchemas['repeat.delete'].parse(input); kind = 'delete'; if (record && record.view.editVersion !== value.expectedVersion) throw new DomainError('DRAFT_SOURCE_CHANGED', '周期任务已变化，请重新查看'); noop = !record;
    }
    return { payload: { scope: { ...scope }, logicalId, id, kind, noop, ...payload }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: noop ? [] : affectedDomains };
  },
  send: async (prepared, ctx) => { const { p, scope, id, kind } = decoded(prepared); if (p.noop === true) return { ec: '200', httpStatus: 200, data: null }; if (kind === 'submit') return ctx.client.request('repeat.submit', { uid: scope.uid, v: stringifyWire(p.raw!) }, scope); if (kind === 'paused') return ctx.client.request('repeat.toggle', { uid: scope.uid, did: id }, scope); if (kind === 'binding') { const value = planBindingSchema.parse(restoreBillInput(p.binding!)); return ctx.client.request('repeat.bindBill', { uid: scope.uid, repeatTaskId: value.planId, billId: value.billId }, scope); } return ctx.client.request('repeat.delete', { uid: scope.uid, did: id }, scope); },
  applyReceipt: (prepared, reply, ctx) => {
    const { p, scope, id, logicalId, kind } = decoded(prepared), cache = new ResourceCache(ctx.repository, ctx.clock); if (p.noop === true) return { items: [{ id: logicalId, state: 'succeeded' }] };
    if (kind === 'submit') { const data = asBillObject(reply.data), raw = asBillObject(data.task), view = repeatView(raw), fields = repeatFieldsSchema.parse(restoreBillInput(p.fields!)); const identityMismatch = p.create === true ? Array.isArray(p.beforeIds) && p.beforeIds.includes(view.id) : view.id !== id; if (!view.packId || !matches(raw, fields) || raw.userid != null && numericText(raw.userid, '') !== scope.uid || identityMismatch) throw new DomainError('REPEAT_RECEIPT_INVALID', '官方周期任务回执与本次输入不一致'); const billIds = applyPlanBills(ctx, scope, data.bills ?? null, { packId: view.packId!, bookId: fields.bookId, types: [view.type] }); cache.confirmResources(scope, 'repeat', [{ id: view.id, kind: 'repeat', raw }]); const affectedIds = [...prepared.affectedIds, `repeat:${view.id}`, ...billIds]; return { items: [{ id: logicalId, state: 'succeeded', affectedIds }], affectedIds, idMap: { [logicalId]: view.id } }; }
    if (kind === 'delete') { const dataset = ctx.repository.dataset(scope, 'repeat'); if (dataset) { ctx.repository.bumpSourceGeneration(scope, 'repeat'); ctx.repository.applyPage(scope, dataset.id, { upserts: [], deletes: [], resources: [], resourceDeletes: [{ id, kind: 'repeat' }], pageState: null }, 'repeat'); } return { items: [{ id: logicalId, state: 'succeeded' }] }; }
    const affectedIds = [...prepared.affectedIds]; if (kind === 'paused') { const view = repeatView(asBillObject(p.before)); if (!view.packId || !view.fields || !Array.isArray(reply.data) || reply.hasMore) throw new DomainError('REPEAT_RECEIPT_INVALID', '启停账单回执无法核对'); affectedIds.push(...applyPlanBills(ctx, scope, reply.data, { packId: view.packId, bookId: view.fields.bookId, types: [view.type] })); }
    return { items: [{ id: logicalId, state: 'uncertain', affectedIds, error: { code: 'REPEAT_GOAL_CHECK', message: '钱迹已受理，等待只读核对任务状态或账单关联' } }], affectedIds };
  },
  reconcile: async (operation, ctx) => {
    if (!operation.prepared) return { items: [] }; const { p, scope, id, kind, logicalId } = decoded(operation.prepared), records = await refreshRepeats(ctx, scope), raw = records.find((raw) => repeatView(raw).id === id); let proved = false;
    if (kind === 'delete') proved = !raw;
    else if (kind === 'paused') proved = !!raw && (repeatView(raw).status === 0) === p.paused && [0, 1].includes(repeatView(raw).status) && (p.noop === true || !!await dependencies.refreshLedger?.(ctx, scope));
    else if (kind === 'binding') { const binding = planBindingSchema.parse(restoreBillInput(p.binding!)); proved = !!raw && repeatView(raw).packId === binding.packId && !!await dependencies.refreshLedger?.(ctx, scope) && planBindingGoal(ctx, scope, binding); }
    else if (p.create !== true && raw && matches(raw, repeatFieldsSchema.parse(restoreBillInput(p.fields!)))) proved = !!await dependencies.refreshLedger?.(ctx, scope);
    return { items: proved ? [{ id: logicalId, state: 'succeeded' }] : [] };
  },
}; }
