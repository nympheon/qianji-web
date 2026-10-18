import type { ItemUpdate, MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject, numericText, positiveBillId } from '../../shared/bill-wire';
import { assetError } from '../assets/model';
import { billVersion, restoreBillInput } from '../ledger/write';
import { categoryDeleteSchema, categoryListSchema } from './contract';
import { categoryCounts, categoryView } from './model';
import { refreshCategories } from './source';
import { createCategoryManagementHandler } from './management';
import { assertNoUnsyncedBills } from '../ledger/pending';
function decode(prepared: PreparedMutation) {
  const p = asBillObject(prepared.payload), s = asBillObject(p.scope);
  if (typeof s.uid !== 'string' || typeof s.connectionEpoch !== 'string' || typeof p.id !== 'string' || typeof p.preparedAt !== 'string' || !Array.isArray(p.beforeIds)) return assetError('CATEGORY_OPERATION_INVALID', '分类操作日志无法核对');
  const scope: ActorScope = { uid: s.uid, connectionEpoch: s.connectionEpoch };
  return { scope, id: p.id, preparedAt: p.preparedAt, input: categoryDeleteSchema.parse(restoreBillInput(p.input!)), beforeIds: p.beforeIds.map((id) => numericText(id, '')), targetBookId: numericText(p.targetBookId, ''), params: asBillObject(p.params) };
}
function removeCategory(ctx: OperationContext, scope: ActorScope, id: string) {
  const dataset = ctx.repository.dataset(scope, 'ledger'); if (!dataset) return assetError('DATASET_MISSING', '分类副本尚未准备');
  ctx.repository.applyPage(scope, dataset.id, { upserts: [], deletes: [], resources: [], resourceDeletes: [{ id, kind: 'category' }], pageState: ctx.repository.syncState(scope, 'ledger', dataset.id)?.pageState ?? null });
}
function createCategoryDeletionHandler(dependencies: { reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      if (command.action !== 'categories.delete') return assetError('CATEGORY_ACTION_UNSUPPORTED', '分类动作尚未实现');
      const input = categoryDeleteSchema.parse(restoreBillInput(command.input)), scope = command.scope, rows = await refreshCategories(ctx, scope, input), raw = rows.find((raw) => positiveBillId(raw.id) === input.id);
      if (!raw) return assetError('CATEGORY_NOT_LOADED', '分类已不在当前列表中');
      const source = categoryView(raw, rows);
      if (!source.editable) return assetError('CATEGORY_NOT_EDITABLE', '该分类由上游标记为不可修改');
      if (source.bookId !== input.bookId) return assetError('CATEGORY_SCOPE_INVALID', '请在分类所属账本操作，不能把全局模板当成当前账本的可写分类');
      if (source.childIds.length) return assetError('CATEGORY_HAS_CHILDREN', '请先处理子分类，再删除父分类');
      if (billVersion(raw) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '分类资料已变化，请重新查看');
      const dataset = ctx.repository.dataset(scope, 'ledger'); if (!dataset?.complete) return assetError('LEDGER_INCOMPLETE', '分类删除前请先完成账单同步');
      assertNoUnsyncedBills(ctx, command);
      let targetBookId = input.bookId;
      if (input.newCategoryId) {
        if (input.newCategoryId === input.id) return assetError('CATEGORY_REPLACE_SELF', '替换分类不能是被删除的分类');
        targetBookId = input.newBookId ?? input.bookId;
        const targetRows = targetBookId === input.bookId ? rows : await refreshCategories(ctx, scope, { bookId: targetBookId, type: input.type }), target = targetRows.find((raw) => positiveBillId(raw.id) === input.newCategoryId);
        if (!target || categoryView(target).type !== input.type || categoryView(target).bookId !== targetBookId) return assetError('CATEGORY_REPLACEMENT_INVALID', '替换分类必须属于明确的目标账本及相同收支类型');
        if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [targetBookId] }).items.length) return assetError('BOOK_NOT_LOADED', '目标账本尚未载入');
      }
      const checked = await ctx.client.request('category.deleteCheck', { uid: scope.uid, did: input.id }, scope), counts = categoryCounts(asBillObject(checked.data));
      const before = ctx.repository.sql.exec<{ id: string }>("SELECT id FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND category_id=? AND member_id=? AND status_code<>0 LIMIT 10001", scope.uid, dataset.id, input.id, scope.uid).toArray();
      if (before.length > 10000) return assetError('CATEGORY_VERIFICATION_LIMIT', '本次操作涉及超过10000笔本人账单，需先使用更小范围处理');
      if (before.length !== counts.count) return assetError('CATEGORY_LEDGER_CHANGED', '官方本人账单计数与当前副本不一致，请先同步后重新核对');
      const id = `category:${input.id}`, affectedIds = [id, ...(input.newCategoryId ? [`category:${input.newCategoryId}`, `book:${targetBookId}`] : [])];
      return { payload: { kind: 'delete', scope: { ...scope }, id: input.id, input: { ...input }, preparedAt: String(ctx.clock.nowMs()), beforeIds: before.map((row) => row.id), targetBookId, params: { uid: scope.uid, did: input.id, deletebills: input.deleteBills ? 1 : 0, ...(input.newCategoryId ? { newcateid: input.newCategoryId } : {}) } },
        items: [{ id, affectedIds }, ...(before.length ? [{ id: `category-ledger:${input.id}`, affectedIds }] : [])], affectedIds, affectedDomains: ['ledger', 'categories', 'assets', 'budget', 'repeat', 'installments', 'savings'] };
    },
    send: async (prepared, ctx) => { const p = decode(prepared); return ctx.client.request('category.delete', p.params, p.scope); },
    applyReceipt: (prepared, reply, ctx) => {
      const p = decode(prepared), result = numericText(reply.data, '');
      if (result !== '0' && result !== '1') return assetError('CATEGORY_DELETE_RECEIPT_INVALID', '分类删除回执没有明确说明分类是否删除');
      if (result === '1') removeCategory(ctx, p.scope, p.id);
      return { items: [{ id: `category:${p.id}`, state: result === '1' ? 'succeeded' : 'failed', ...(result === '0' ? { error: { code: 'CATEGORY_NOT_DELETED', message: '上游未删除此分类，相关本人账单处理结果仍需单独核对' } } : {}) }, ...(p.beforeIds.length ? [{ id: `category-ledger:${p.id}`, state: 'uncertain' as const, error: { code: 'CATEGORY_LEDGER_CHECK', message: '等待只读同步核对本人账单的迁移、保留或删除结果' } }] : [])] };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] }; const p = decode(operation.prepared), items: ItemUpdate[] = [];
      const unresolved = new Set(operation.items.filter((item) => item.state === 'uncertain' || item.state === 'sending').map((item) => item.id));
      if (unresolved.has(`category:${p.id}`)) {
        const rows = await refreshCategories(ctx, p.scope, categoryListSchema.parse({ bookId: p.input.bookId, type: p.input.type }));
        if (!rows.some((row) => positiveBillId(row.id) === p.id)) { removeCategory(ctx, p.scope, p.id); items.push({ id: `category:${p.id}`, state: 'succeeded' }); }
      }
      if (!unresolved.has(`category-ledger:${p.id}`) || !await dependencies.reconcileSource?.(ctx)) return { items };
      const dataset = ctx.repository.dataset(p.scope, 'ledger'); if (!dataset?.complete || !dataset.validatedAt || Date.parse(dataset.validatedAt) < Number(p.preparedAt)) return { items };
      const verified = p.beforeIds.every((id) => {
        const row = ctx.repository.readBill(p.scope, id), raw = row ? asBillObject(row.raw) : null;
        if (p.input.deleteBills) return !raw || numericText(raw.status, '1') === '0';
        if (!raw || numericText(raw.status, '1') === '0' || numericText(raw.userid, '') !== p.scope.uid) return false;
        return !p.input.newCategoryId || positiveBillId(raw.cateid) === p.input.newCategoryId && numericText(raw.bookid, '') === p.targetBookId;
      });
      if (verified) items.push({ id: `category-ledger:${p.id}`, state: 'succeeded' }); return { items };
    },
  };
}
export function createCategoryMutationHandler(dependencies: { reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  const deletion = createCategoryDeletionHandler(dependencies), management = createCategoryManagementHandler(), choose = (prepared: PreparedMutation) => asBillObject(prepared.payload).kind === 'delete' ? deletion : management;
  return { prepare: (command, ctx) => (command.action === 'categories.delete' ? deletion : management).prepare(command, ctx), send: (prepared, ctx) => choose(prepared).send(prepared, ctx), applyReceipt: (prepared, reply, ctx) => choose(prepared).applyReceipt(prepared, reply, ctx), reconcile: (operation, ctx) => operation.prepared ? choose(operation.prepared).reconcile(operation, ctx) : Promise.resolve({ items: [] }) };
}
