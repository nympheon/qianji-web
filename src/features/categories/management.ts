import { LosslessNumber } from 'lossless-json';
import type { MutationHandler, MutationCommand, OperationContext, PreparedMutation } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { stringifyWire, type WireJson } from '../../shared/wire-json';
import { ResourceCache } from '../../storage/cache';
import { assetError } from '../assets/model';
import { billVersion, restoreBillInput } from '../ledger/write';
import { categoryLevelSchema, categoryListSchema, categoryMoveSchema, categoryReorderSchema, categorySubmitSchema, type CategoryListInput, type CategoryReorderInput } from './contract';
import { categoryView, flattenCategories } from './model';
import { refreshCategories } from './source';
function decode(prepared: PreparedMutation) {
  const p = asBillObject(prepared.payload), s = asBillObject(p.scope);
  if (typeof s.uid !== 'string' || typeof s.connectionEpoch !== 'string' || typeof p.id !== 'string' || typeof p.logicalId !== 'string' || !['submit', 'level', 'move', 'reorder'].includes(String(p.kind))) return assetError('CATEGORY_OPERATION_INVALID', '分类管理日志无法识别');
  const scope: ActorScope = { uid: s.uid, connectionEpoch: s.connectionEpoch };
  return { scope, id: p.id, logicalId: p.logicalId, kind: p.kind, create: p.create === true, noop: p.noop === true, params: asBillObject(p.params), expected: asBillObject(p.expected), scopeInput: categoryListSchema.parse(restoreBillInput(p.scopeInput!)), raw: p.raw, groups: p.groups };
}
function checkSource(raw: BillObject, all: BillObject[], input: CategoryListInput, expectedVersion: string) {
  const view = categoryView(raw, all);
  if (!view.editable) return assetError('CATEGORY_NOT_EDITABLE', '上游标记该分类不可修改');
  if (view.bookId !== input.bookId || view.type !== input.type) return assetError('CATEGORY_SCOPE_INVALID', '分类不属于当前账本和收支类型');
  if (billVersion(raw) !== expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '分类资料已变化，请重新查看'); return view;
}
function parentCategory(id: string, rows: BillObject[], input: CategoryListInput, sourceId?: string) {
  const raw = rows.find((row) => positiveBillId(row.id) === id); if (!raw || id === sourceId) return assetError('CATEGORY_PARENT_INVALID', '目标父分类无效');
  const parent = categoryView(raw, rows); if (parent.level !== 1 || parent.parentId !== null || parent.bookId !== input.bookId || parent.type !== input.type) return assetError('CATEGORY_PARENT_INVALID', '目标必须为同账本、相同收支类型的一级分类'); return parent;
}
function validateOrder(input: CategoryReorderInput, rows: BillObject[]) {
  const parents = new Set<string>(), ids = new Set<string>(), all = rows.map((row) => categoryView(row));
  for (const group of input.groups) {
    const key = group.parentId ?? '-1'; if (parents.has(key)) return assetError('CATEGORY_ORDER_INVALID', '同一个层级分组不能重复'); parents.add(key);
    if (group.parentId) parentCategory(group.parentId, rows, input);
    const siblings = all.filter((row) => row.parentId === group.parentId).map((row) => row.id);
    if (siblings.length !== group.ids.length || group.ids.some((id) => ids.has(id) || !siblings.includes(id))) return assetError('CATEGORY_ORDER_INVALID', '每组排序必须完整包含该层级的真实分类，不能顺带移动分类'); group.ids.forEach((id) => ids.add(id));
  }
  if (ids.size !== all.length || !input.groups[0] || input.groups[0].parentId !== null) return assetError('CATEGORY_ORDER_INVALID', '排序需先给出完整一级分类组，再给出全部子分类组');
}
function orderMatches(groups: WireJson | undefined, rows: BillObject[]): boolean {
  if (!Array.isArray(groups)) return false;
  const views = rows.map((row) => categoryView(row));
  return groups.every((value) => { const group = asBillObject(value), parent = group.parentId === null ? null : numericText(group.parentId, ''), ids = Array.isArray(group.ids) ? group.ids.map((id) => numericText(id, '')) : []; return ids.length > 0 && JSON.stringify(views.filter((view) => view.parentId === parent).map((view) => view.id)) === JSON.stringify(ids); });
}
function matches(raw: BillObject, expected: BillObject): boolean {
  const view = categoryView(raw);
  if (view.bookId !== expected.bookId || numericText(raw.type, '0') !== numericText(expected.type, '') || view.parentId !== (expected.parentId ?? null) || String(view.level) !== numericText(expected.level, '')) return false;
  return (expected.name === undefined || view.name === expected.name) && (expected.icon === undefined || view.icon === expected.icon);
}
async function prepare(command: MutationCommand, ctx: OperationContext): Promise<PreparedMutation> {
  const parsed = restoreBillInput(command.input), scope = command.scope, isSubmit = command.action === 'categories.submit', isLevel = command.action === 'categories.changeLevel', isMove = command.action === 'categories.move';
  if (!isSubmit && !isLevel && !isMove && command.action !== 'categories.reorder') return assetError('CATEGORY_ACTION_UNSUPPORTED', '分类动作尚未实现');
  const input = isSubmit ? categorySubmitSchema.parse(parsed) : isLevel ? categoryLevelSchema.parse(parsed) : isMove ? categoryMoveSchema.parse(parsed) : categoryReorderSchema.parse(parsed), scopeInput = { bookId: input.bookId, type: input.type }, rows = await refreshCategories(ctx, scope, scopeInput);
  if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [input.bookId] }).items.length) return assetError('BOOK_NOT_LOADED', '账本尚未载入');
  const logicalId = `category:${command.requestId}`;
  if ('groups' in input) {
    validateOrder(input, rows); const affectedIds = input.groups.flatMap((group) => group.ids.map((id) => `category:${id}`));
    return { payload: { scope: { ...scope }, scopeInput, id: 'order', logicalId, kind: 'reorder', groups: input.groups, expected: {}, params: { uid: scope.uid, v: stringifyWire(input.groups.map((group) => group.ids.map((id) => new LosslessNumber(id)))) } }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['ledger', 'categories'] };
  }
  const create = 'mode' in input && input.mode === 'create', old = 'id' in input ? rows.find((row) => positiveBillId(row.id) === input.id) : null;
  if (!create && !old) return assetError('CATEGORY_NOT_LOADED', '原分类已不在完整列表中');
  const source = old && 'expectedVersion' in input ? checkSource(old, rows, scopeInput, input.expectedVersion) : null;
  const params: BillObject = { uid: scope.uid }, expected: BillObject = { bookId: input.bookId, type: input.type }; let parentId: string | null, kind: 'submit' | 'level' | 'move', noop = false;
  if ('mode' in input) {
    kind = 'submit'; parentId = input.mode === 'create' ? input.parentId : source!.parentId;
    if (parentId) parentCategory(parentId, rows, scopeInput);
    if (input.mode === 'edit' && input.icon === '' && source!.icon) return assetError('CATEGORY_ICON_CLEAR_UNVERIFIED', '原生提交会省略空图标，不能据此声称已清空原图标');
    const name = input.name ?? source!.name, icon = input.icon ?? source?.icon;
    params.bookid = input.bookId; params.t = input.type; params.v = name;
    if (input.mode === 'edit') params.did = input.id;
    if (parentId) params.parentid = parentId;
    if (icon) params.icon = icon;
    expected.name = name; if (icon) expected.icon = icon;
  } else {
    kind = isLevel ? 'level' : 'move'; parentId = input.parentId;
    if (kind === 'move' && source!.level !== 2) return assetError('CATEGORY_MOVE_REQUIRES_CHILD', '移动子分类操作只接受已有二级分类');
    if (parentId) parentCategory(parentId, rows, scopeInput, source!.id);
    if (parentId && source!.childIds.length) return assetError('CATEGORY_HAS_CHILDREN', '请先处理子分类，再把该一级分类降为二级');
    if (kind === 'level' && parentId && source!.parentId && source!.parentId !== parentId) return assetError('CATEGORY_MOVE_REQUIRED', '更换已有子分类的父分类请使用移动操作');
    noop = source!.parentId === parentId;
    params.did = source!.id; if (kind === 'move' || parentId) params.parentid = parentId!;
    expected.name = source!.name; if (source!.icon) expected.icon = source!.icon;
  }
  expected.parentId = parentId; expected.level = parentId ? 2 : 1;
  const id = source?.id ?? '-1', affectedIds = [...new Set([create ? 'category-catalog' : `category:${id}`, ...(parentId ? [`category:${parentId}`] : []), ...(source?.parentId ? [`category:${source.parentId}`] : [])])];
  return { payload: { scope: { ...scope }, scopeInput, id, logicalId, kind, create, noop, expected, raw: old ?? {}, params }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['ledger', 'categories', 'budget', 'repeat', 'installments', 'savings'] };
}
export function createCategoryManagementHandler(): MutationHandler {
  return {
    prepare,
    send: async (prepared, ctx) => { const p = decode(prepared); if (p.noop) return { ec: '200', httpStatus: 200, data: p.raw ?? null }; return ctx.client.request(p.kind === 'submit' ? 'category.submit' : p.kind === 'level' ? 'category.changeLevel' : p.kind === 'move' ? 'category.move' : 'category.reorder', p.params, p.scope); },
    applyReceipt: (prepared, reply, ctx) => {
      const p = decode(prepared); if (p.kind === 'reorder') return { items: [{ id: p.logicalId, state: 'uncertain', error: { code: 'CATEGORY_ORDER_CHECK', message: '排序已受理，需读取官方父子分类顺序核对' } }] };
      const raw = asBillObject(reply.data), view = categoryView(raw);
      if ((!p.create && view.id !== p.id) || !matches(raw, p.expected)) return assetError('CATEGORY_RECEIPT_INVALID', '官方分类回执与本次名称、层级、账本或ID不一致');
      if (p.create && ctx.repository.readResources(p.scope, 'category', { domain: 'ledger', ids: [view.id] }).items.length) return assetError('CATEGORY_NEW_ID_CONFLICT', '新增分类回执复用了已存在ID');
      const group = view.level === 1 ? flattenCategories([raw], p.scopeInput) : [raw];
      if (view.level === 2 && Array.isArray(raw.sublist) && raw.sublist.length) return assetError('CATEGORY_LEVEL_UNSUPPORTED', '二级分类回执不应包含更深层级');
      new ResourceCache(ctx.repository, ctx.clock).confirmResources(p.scope, 'ledger', group.map((raw) => ({ id: numericText(raw.id, ''), kind: 'category', raw })));
      const affectedIds = [...new Set([...prepared.affectedIds, ...group.map((row) => `category:${numericText(row.id, '')}`)])];
      return { items: [{ id: p.logicalId, state: 'succeeded', affectedIds }], affectedIds, ...(p.create ? { idMap: { [p.logicalId]: view.id } } : {}) };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] }; const p = decode(operation.prepared); if (p.create) return { items: [] };
      const rows = await refreshCategories(ctx, p.scope, p.scopeInput);
      if (p.kind === 'reorder') return orderMatches(p.groups, rows) ? { items: [{ id: p.logicalId, state: 'succeeded' }] } : { items: [] };
      const raw = rows.find((row) => positiveBillId(row.id) === p.id); return raw && matches(raw, p.expected) ? { items: [{ id: p.logicalId, state: 'succeeded' }] } : { items: [] };
    },
  };
}
