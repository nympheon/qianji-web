import {runLedgerExtended} from './ledger-extended.mts';
import {runSavingsLinked,runSavingsModes} from './savings-linked.mts';
import {runConflicts,runReceiptLoss} from './conflicts.mts';
import {runManagement,runCategoryManagement,runTagManagement} from './management.mts';
import {runCache,runBudgetNative} from './cache.mts';
import {runMedia} from './media.mts';
import {runInstallments} from './installments.mts';
import {runDebt} from './debt.mts';
import {runAssets} from './assets.mts';
import { DomainError } from '../../src/shared/errors';
import type { ActionName,ActionInput,ActionOutputs } from '../../src/contracts/actions';
import type { OperationView } from '../../src/operations/contract';
import type { TestResource } from './scope.mts';
import { compareMoney } from '../../src/shared/numbers';
import { runCatalogs,runBudget,runCatalogBatch } from './catalogs.mts';
import type { CacheKey } from '../../src/storage/cache';
import { runForeign,runTransferRefund,runReimbursement } from './ledger.mts';
import { runRepeat,runSavings,runNativeSavings,runRepeatWire } from './plans.mts';

import type { CaseName } from './contract.mts';
export const testActions=['books.submit','categories.submit','categories.submitMany','books.configure','books.setVisible','books.delete','assets.delete','categories.changeLevel','categories.move','categories.reorder','categories.delete','tags.reorderTags','tags.deleteTag','tags.deleteGroup','attachments.upload','installments.create','installments.configure','installments.prepay','installments.delete','debt.create','debt.appendPrincipal','debt.pay','assets.setFinished','assets.submit','assets.adjustBalance','assets.setVisible','assets.groups.submit','assets.groups.delete','assets.groups.add','assets.groups.remove','ledger.create','ledger.edit','ledger.delete','ledger.transfer','ledger.repayCard','ledger.refund','ledger.reimburse','ledger.cancelReimbursement','tags.submitGroup','tags.submitTag','tags.setArchived','budget.submit','repeat.submit','repeat.setPaused','repeat.delete','savings.submit','savings.deposit','savings.cancelDeposit','savings.delete'] as const;
export interface CaseEnvironment {
 armReceiptLoss():void;
 billPostCount():number;
 prefix:string;
 read<A extends ActionName>(action:A,input:ActionInput<A>,allowFreshPartial?:boolean):Promise<ActionOutputs[A]>;
 write(step:string,action:ActionName,input:Record<string,unknown>):Promise<OperationView>;
 remember(alias:string,kind:TestResource,id:string):void;
 known(alias:string):string;
 optional(alias:string):string|undefined;
 synchronize():Promise<void>;
 invalidateSource(key:CacheKey):void;
 checkpoint<T>(key:string,value:T):T;
}
function created(operation:OperationView):string{
 const ids=[...new Set(Object.values(operation.idMap??{}))];
 if(!ids.length&&operation.action==='ledger.create'&&operation.items.length===1&&operation.items[0]?.state==='succeeded'&&/^[1-9]\d+$/.test(operation.items[0].id))return operation.items[0].id;
 if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','新建结果缺少唯一官方ID，请保留原操作');
 return ids[0]!;
}
export async function runCase(name:CaseName,e:CaseEnvironment){
 if(name==='ledger-extended')return runLedgerExtended(e);
 if(name==='cache-routes')return runCache(e,true);
 if(name==='budget-native')return runBudgetNative(e);
 if(name==='cache-routes-budget')return runCache(e);
 if(name==='management')return runManagement(e);
 if(name==='category-management')return runCategoryManagement(e);
 if(name==='tag-management')return runTagManagement(e);
 if(name==='conflicts')return runConflicts(e);
 if(name==='receipt-loss-recover')return runReceiptLoss(e,true);
 if(name==='receipt-loss')return runReceiptLoss(e);
 if(name==='savings-modes')return runSavingsModes(e);
 if(name==='savings-linked')return runSavingsLinked(e);
 if(name==='media')return runMedia(e);
 if(name==='installments')return runInstallments(e);
 if(name==='debt')return runDebt(e);
 if(name==='assets-management')return runAssets(e);
 if(name==='ledger-foreign')return runForeign(e);
 if(name==='transfer-refund')return runTransferRefund(e);
 if(name==='reimbursement')return runReimbursement(e);
 if(name==='repeat')return runRepeat(e);
 if(name==='savings')return runSavings(e);
 if(name==='savings-native')return runNativeSavings(e);
 if(name==='repeat-wire')return runRepeatWire(e);
 if(name==='repeat-ack')return runRepeatWire(e,'ack');
 if(name==='catalogs')return runCatalogs(e);
 if(name==='catalog-batch')return runCatalogBatch(e);
 if(name==='budget')return runBudget(e);
 if(name==='status')return {state:'ready'};
 if(name==='bootstrap'){
  if(!e.optional('book')){
   const types=await e.read('books.types',{}),normal=types.items.find(item=>item.type===-1);
   if(!normal)throw new DomainError('ACCEPTANCE_TYPE_MISSING','未找到官方日常账本类型');
   const result=await e.write('book-create','books.submit',{mode:'create',name:e.prefix+'专用测试账本',type:normal.type});
   e.remember('book','book',created(result));
  }
  await e.read('books.list',{includeHidden:true});
  for(const type of [0,1] as const){
   const alias=type===0?'expense-category':'income-category';
   if(e.optional(alias))continue;
   const list=await e.read('categories.list',{bookId:e.known('book'),type});
   const own=list.items.find(item=>item.bookId===e.known('book')&&item.type===type&&item.level===1);
   if(own)e.remember(alias,'category',own.id);
   else e.remember(alias,'category',created(await e.write(alias,'categories.submit',{mode:'create',bookId:e.known('book'),type,name:e.prefix+(type===0?'支出':'收入'),parentId:null})));
  }
  return {state:'ready',bookCreated:true};
 }
 if(name==='assets'||name==='assets-native'){
  await e.read('assets.types',{});
  for(const [alias,currency] of [['cash-a','CNY'],['cash-b','CNY'],['cash-usd','USD']] as const){
   const label=name==='assets-native'?'native-'+alias:alias;
   if(!e.optional(alias))e.remember(alias,'asset',created(await e.write(label,'assets.submit',{mode:'create',fields:{name:e.prefix+label,type:1,subtype:11,currency,money:'0',inCount:false,remark:e.prefix+'仅用于接口验收'}})));
   const detail=await e.read('assets.detail',{id:e.known(alias)},true);
   if(detail.asset?.currency!==currency||compareMoney(detail.asset.money,'0')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','新建测试资产回拉不一致');
  }
  return {state:'ready',assetsCreated:3};
 }
 if(name==='ledger-basic'){
  await e.synchronize();
  await e.read('ledger.transfer.options',{},true);
  const input={bookId:e.known('book'),type:0,categoryId:e.known('expense-category'),assetId:e.known('cash-a'),enteredMoney:'1.23',fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'普通支出'};
  if(!e.optional('basic-bill'))e.remember('basic-bill','bill',created(await e.write('basic-create','ledger.create',{bills:[input]})));
  await e.synchronize();
  const before=await e.read('ledger.detail',{id:e.known('basic-bill')});
  if(before.bookId!==e.known('book')||before.money!=='1.23')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','普通测试账单回拉金额或账本不一致');
  await e.write('basic-edit','ledger.edit',{bills:[{id:before.id,expectedVersion:before.editVersion,changes:{remark:e.prefix+'普通支出已编辑'}}]});
  await e.synchronize();
  const after=await e.read('ledger.detail',{id:before.id});
  if(after.remark!==e.prefix+'普通支出已编辑'||after.money!=='1.23')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','编辑后回拉未保留目标金额与备注');
  return {state:'ready',createdAndEdited:true};
 }
}
