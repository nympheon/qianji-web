import { compareMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import type { MutationHandler } from '../../operations/contract';
import { asBillObject, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { stringifyWire } from '../../shared/wire-json';
import { budgetChangesSchema, budgetQuerySchema } from './contract';
import { budgetKey, budgetParams, budgetTypeInfo, publishBudget, refreshBudget } from './source';
import { restoreBillInput } from '../ledger/write';
import { assetError } from '../assets/model';
export function createBudgetMutationHandler(): MutationHandler { return {
  prepare: async (command, ctx) => {
    if (command.action !== 'budget.submit') return assetError('BUDGET_ACTION_UNSUPPORTED', '预算动作尚未实现'); const input = budgetChangesSchema.parse(restoreBillInput(command.input)), scope = command.scope;
    const query = budgetQuerySchema.parse({ bookId: input.bookId, date: input.date, range: input.range, zone: input.zone });
    if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [query.bookId] }).items.length) return assetError('BOOK_NOT_LOADED', '目标账本尚未载入'); const prior = await refreshBudget(ctx, scope, query);
    if (prior.editVersion !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '预算配置已变化，请重新查看');
    const changes = input.changes.map((change) => {
      if (change.categoryId) { const row = ctx.repository.readResources(scope, 'category', { domain: 'ledger', ids: [change.categoryId] }).items[0]; if (!row) return assetError('CATEGORY_NOT_LOADED', '预算分类尚未载入'); const category = asBillObject(row.raw); if (!['-1', query.bookId].includes(numericText(category.bookid, '-1')) || numericText(category.type, '0') !== '0') return assetError('CATEGORY_SCOPE_INVALID', '预算分类必须属于所选账本的支出类型'); }
      const old = prior.list.find((row) => change.categoryId === null ? numericText(row.flag, '2') === '1' : numericText(row.flag, '2') === '2' && positiveBillId(row.cateid) === change.categoryId);
      const raw: BillObject = old ? { ...old } : { bookid: new LosslessNumber(query.bookId), userid: scope.uid, type: query.date.kind === 'month' ? 1 : 2, typeinfo: budgetTypeInfo(query), flag: change.categoryId === null ? 1 : 2, cateid: new LosslessNumber(change.categoryId ?? '-1'), count: 0, used: 0, notbudget: 0, totalCateLimit: 0, totalCateUsed: 0 };
      raw.money = new LosslessNumber(change.limit); delete raw.category; delete raw.createtime; return raw;
    });
    const logicalId = `budget:${command.requestId}`, affectedIds = [budgetKey(query).queryKey]; return { payload: { scope: { ...scope }, query, params: { ...budgetParams(scope, query), changelist: stringifyWire(changes) }, logicalId, changes: input.changes }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['budget'] };
  },
  send: async (prepared, ctx) => { const p = asBillObject(prepared.payload), s = asBillObject(p.scope); return ctx.client.request('budget.submit', asBillObject(p.params), { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }); },
  applyReceipt: (prepared, reply, ctx) => { const p = asBillObject(prepared.payload), s = asBillObject(p.scope), query = budgetQuerySchema.parse(restoreBillInput(p.query!)); publishBudget(ctx, { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }, query, reply.data); return { items: [{ id: String(p.logicalId), state: 'succeeded' }] }; },
  reconcile: async (operation, ctx) => { if (!operation.prepared) return { items: [] }; const p = asBillObject(operation.prepared.payload), query = budgetQuerySchema.parse(restoreBillInput(p.query!)), value = await refreshBudget(ctx, operation.scope, query); if (!Array.isArray(p.changes)) return { items: [] }; const matches = p.changes.every((value2) => { const change = asBillObject(value2), id = typeof change.categoryId === 'string' ? change.categoryId : null, row = value.configurations.find((row) => row.categoryId === id); return row ? compareMoney(row.limit, numericText(change.limit, '0')) === 0 : numericText(change.limit, '') === '0'; }); return matches ? { items: [{ id: String(p.logicalId), state: 'succeeded' }] } : { items: [] }; },
}; }
