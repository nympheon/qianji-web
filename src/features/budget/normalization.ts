import {asBillObject,moneyText,numericText,positiveBillId,type BillObject} from '../../shared/bill-wire';
import {addMoney,compareMoney} from '../../shared/numbers';
import {DomainError} from '../../shared/errors';
import {LosslessNumber} from 'lossless-json';

/** BudgetSetNew.__setup: existing parents cover their children; standalone children stay independent. */
export function normalizeBudgetCollection(collection:Map<string,BillObject>,category:(id:string)=>BillObject|undefined,newTotal:()=>BillObject):void{
 const parents=new Map<string,string|null>(),children=new Map<string,string>();
 for(const [id,row]of collection){
  if(id==='total')continue;
  const raw=category(id)??(row.category==null?undefined:asBillObject(row.category));
  if(!raw)throw new DomainError('BUDGET_CATEGORY_NOT_LOADED','预算分类层级尚未完整载入，请先同步');
  const parent=positiveBillId(raw.parentid);parents.set(id,parent);
  if(parent&&collection.has(parent))children.set(parent,addMoney(children.get(parent)??'0',moneyText(row.money)));
 }
 for(const [id,sum]of children){const row=collection.get(id)!;if(compareMoney(moneyText(row.money),sum)<0)row.money=new LosslessNumber(sum);}
 let limit='0',used='0';
 for(const [id,parent]of parents){if(parent&&collection.has(parent))continue;const row=collection.get(id)!;limit=addMoney(limit,moneyText(row.money));used=addMoney(used,moneyText(row.used));}
 if(!collection.has('total')&&parents.size)collection.set('total',newTotal());
 const total=collection.get('total');if(total){if(compareMoney(moneyText(total.money),limit)<0)total.money=new LosslessNumber(limit);total.totalCateLimit=new LosslessNumber(limit);total.totalCateUsed=new LosslessNumber(used);}
}
export const budgetCollectionGoals=(collection:Map<string,BillObject>)=>[...collection].map(([id,row])=>({categoryId:id==='total'?null:id,limit:numericText(row.money,'0')}));
