import { compareMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import type { MutationHandler } from '../../operations/contract';
import { asBillObject, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { stringifyWire } from '../../shared/wire-json';
import { budgetChangesSchema, budgetQuerySchema } from './contract';
import { budgetKey, budgetParams, budgetTypeInfo, parseBudgets, publishBudget, refreshBudget } from './source';
import { restoreBillInput } from '../ledger/write';
import { assetError } from '../assets/model';
import {normalizeBudgetCollection,budgetCollectionGoals} from './normalization';
function matchesGoals(changes:unknown,configurations:ReturnType<typeof parseBudgets>['configurations']):boolean{
 return Array.isArray(changes)&&changes.every(value=>{const change=asBillObject(value),id=typeof change.categoryId==='string'?change.categoryId:null,row=configurations.find(row=>row.categoryId===id);return row?compareMoney(row.limit,numericText(change.limit,'0'))===0:numericText(change.limit,'')==='0';});
}
export function createBudgetMutationHandler(): MutationHandler { return {
  prepare: async (command, ctx) => {
    if (command.action !== 'budget.submit') return assetError('BUDGET_ACTION_UNSUPPORTED', '预算动作尚未实现'); const input = budgetChangesSchema.parse(restoreBillInput(command.input)), scope = command.scope;
    const query = budgetQuerySchema.parse({ bookId: input.bookId, date: input.date, range: input.range, zone: input.zone });
    if (!ctx.repository.readResources(scope, 'book', { domain: 'books', ids: [query.bookId] }).items.length) return assetError('BOOK_NOT_LOADED', '目标账本尚未载入'); const prior = await refreshBudget(ctx, scope, query);
    if (prior.editVersion !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '预算配置已变化，请重新查看');
    const key=(row:BillObject)=>numericText(row.flag,'2')==='1'?'total':positiveBillId(row.cateid)!;
    const collection=new Map(prior.list.map(row=>[key(row),{...row}]));
    const newRow=(id:string|null):BillObject=>({bookid:new LosslessNumber(query.bookId),userid:scope.uid,type:query.date.kind==='month'?1:2,typeinfo:budgetTypeInfo(query),flag:id===null?1:2,cateid:new LosslessNumber(id??'-1'),count:0,used:0,notbudget:0,totalCateLimit:0,totalCateUsed:0,money:0});
    for(const change of input.changes) {
      if (change.categoryId) { const row = ctx.repository.readResources(scope, 'category', { domain: 'ledger', ids: [change.categoryId] }).items[0]; if (!row) return assetError('CATEGORY_NOT_LOADED', '预算分类尚未载入'); const category = asBillObject(row.raw); if (!['-1', query.bookId].includes(numericText(category.bookid, '-1')) || numericText(category.type, '0') !== '0') return assetError('CATEGORY_SCOPE_INVALID', '预算分类必须属于所选账本的支出类型'); }
      const id=change.categoryId??'total';
      if(change.categoryId!==null&&compareMoney(change.limit,'0')===0){collection.delete(id);continue;}
      const old = collection.get(id);
      const raw: BillObject = old ? { ...old } : newRow(change.categoryId);
      raw.money = new LosslessNumber(change.limit); collection.set(id,raw);
    }
    normalizeBudgetCollection(collection,id=>{const row=ctx.repository.readResources(scope,'category',{domain:'ledger',ids:[id]}).items[0];return row?asBillObject(row.raw):undefined;},()=>newRow(null));
    if(collection.has('total')&&compareMoney(moneyText(collection.get('total')!.money),'0')===0)return assetError('BUDGET_TOTAL_ZERO_UNSUPPORTED','钱迹接口不接受空总预算，请保留正数总额；分类预算可设0取消');
    const goals=[...budgetCollectionGoals(collection),...input.changes.filter(change=>change.categoryId!==null&&!collection.has(change.categoryId))];
    const changes=[...collection.values()].map(raw=>{delete raw.category;delete raw.createtime;return raw;});
    const logicalId = `budget:${command.requestId}`, affectedIds = [budgetKey(query).queryKey]; return { payload: { scope: { ...scope }, query, params: { ...budgetParams(scope, query), changelist: stringifyWire(changes) }, logicalId, changes: goals }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['budget'] };
  },
  send: async (prepared, ctx) => { const p = asBillObject(prepared.payload), s = asBillObject(p.scope); return ctx.client.request('budget.submit', asBillObject(p.params), { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }); },
  applyReceipt: (prepared, reply, ctx) => { const p = asBillObject(prepared.payload), s = asBillObject(p.scope), query = budgetQuerySchema.parse(restoreBillInput(p.query!)); if(!matchesGoals(p.changes,parseBudgets(reply.data,query).configurations))return assetError('BUDGET_RECEIPT_MISMATCH','官方预算回执未保存本次归一后的额度，请保留原操作核查'); publishBudget(ctx, { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }, query, reply.data); return { items: [{ id: String(p.logicalId), state: 'succeeded' }] }; },
  reconcile: async (operation, ctx) => { if (!operation.prepared) return { items: [] }; const p = asBillObject(operation.prepared.payload), query = budgetQuerySchema.parse(restoreBillInput(p.query!)), value = await refreshBudget(ctx, operation.scope, query); if (!Array.isArray(p.changes)) return { items: [] }; const matches = matchesGoals(p.changes,value.configurations); return matches ? { items: [{ id: String(p.logicalId), state: 'succeeded' }] } : { items: [] }; },
}; }
