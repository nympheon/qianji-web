import { DomainError } from '../../src/shared/errors';
import { compareMoney,subtractMoney } from '../../src/shared/numbers';
import { assetInfoKey } from '../../src/features/assets/service';
import type { OperationView } from '../../src/operations/contract';
import type { CaseEnvironment } from './cases.mts';

export function createdBill(operation:OperationView){
 const ids=[...new Set(Object.values(operation.idMap??{}))];if(ids.length===1)return ids[0]!;
 const items=operation.items.filter(item=>item.state==='succeeded'&&/^[1-9]\d+$/.test(item.id));
 if(items.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','账单新建缺少唯一成功ID');return items[0]!.id;
}
export async function runForeign(e:CaseEnvironment){
 await e.synchronize();const options=await e.read('ledger.transfer.options',{},true);if(options.baseCurrency!=='CNY')throw new DomainError('ACCEPTANCE_CURRENCY_MISMATCH','本例仅针对当前CNY本位币，不修改全局配置');
 const examples=[
  {alias:'foreign-discount',assetId:e.known('cash-a'),enteredMoney:'2',fee:'-0.2',money:'12.6',currency:{srcSymbol:'USD',srcValue:'2',targetSymbol:'CNY',targetValue:'12.6',baseSymbol:'CNY',baseValue:'12.6'}},
  {alias:'foreign-target',assetId:e.known('cash-usd'),enteredMoney:'7',fee:'0',money:'1',currency:{srcSymbol:'CNY',srcValue:'7',targetSymbol:'USD',targetValue:'1',baseSymbol:'CNY',baseValue:'7'}},
  {alias:'foreign-no-asset',assetId:null,enteredMoney:'1',fee:'0',money:'1',currency:{srcSymbol:'USD',srcValue:'1',targetSymbol:'CNY',targetValue:'7',baseSymbol:'CNY',baseValue:'7'}},
 ];
 for(const sample of examples){
  if(!e.optional(sample.alias)){
   const result=await e.write(sample.alias,'ledger.create',{bills:[{bookId:e.known('book'),categoryId:e.known('expense-category'),type:0,assetId:sample.assetId,enteredMoney:sample.enteredMoney,fee:sample.fee,currency:sample.currency,timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+sample.alias,tagIds:[e.known('tag')]}]});e.remember(sample.alias,'bill',createdBill(result));
  }
 }
 await e.synchronize();
 for(const sample of examples){const detail=await e.read('ledger.detail',{id:e.known(sample.alias)});if(compareMoney(detail.money,sample.money)!==0||detail.currency?.srcSymbol!==sample.currency.srcSymbol||compareMoney(detail.currency.srcValue,sample.currency.srcValue)!==0||compareMoney(detail.currency.targetValue,sample.currency.targetValue)!==0||compareMoney(detail.currency.baseValue,sample.currency.baseValue)!==0||compareMoney(detail.transferFee,sample.fee)!==0||!detail.tagIds.includes(e.known('tag')))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','多币种、优惠或标签在官方同步后不一致');}
 return {state:'ready',foreignAssetAndDiscountAndHistoricalValues:true};
}
async function assetMoney(e:CaseEnvironment,alias:string){const id=e.known(alias);e.invalidateSource(assetInfoKey(id));const view=await e.read('assets.detail',{id},true);if(!view.asset)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试资产详情缺失');return view.asset.money;}
export async function runTransferRefund(e:CaseEnvironment){
 await e.synchronize();await e.read('ledger.transfer.options',{},true);
 const balances=e.checkpoint('transfer-balances',{from:await assetMoney(e,'cash-a'),target:await assetMoney(e,'cash-b')});
 if(!e.optional('transfer')){
  const result=await e.write('transfer-create','ledger.transfer',{mode:'create',bookId:e.known('book'),fromAssetId:e.known('cash-a'),targetAssetId:e.known('cash-b'),enteredMoney:'2',fee:'0.1',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'转账手续费',tagIds:[e.known('tag')]});e.remember('transfer','bill',createdBill(result));
 }
 await e.synchronize();const transfer=await e.read('ledger.detail',{id:e.known('transfer')});
 if(transfer.type!==2||compareMoney(transfer.money,'1.9')!==0||compareMoney(transfer.transferFee,'0.1')!==0||compareMoney(subtractMoney(balances.from,await assetMoney(e,'cash-a')),'2')!==0||compareMoney(subtractMoney(await assetMoney(e,'cash-b'),balances.target),'1.9')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','转账本金、手续费或双向资产变化不一致');
 const beforeRefund=e.checkpoint('refund-balance',await assetMoney(e,'cash-a'));
 if(!e.optional('refund')){
  const source=await e.read('ledger.detail',{id:e.known('basic-bill')});
  const result=await e.write('refund-create','ledger.refund',{billId:source.id,expectedVersion:source.editVersion,money:'0.23',assetId:e.known('cash-a'),timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'部分退款',tagIds:[e.known('tag')]});e.remember('refund','bill',createdBill(result));
 }
 await e.synchronize();const refund=await e.read('ledger.detail',{id:e.known('refund')}),source=await e.read('ledger.detail',{id:e.known('basic-bill')});
 if(refund.type!==20||compareMoney(refund.money,'0.23')!==0||!source.refundIds.includes(refund.id)||refund.refundSourceId!==source.id||compareMoney(subtractMoney(await assetMoney(e,'cash-a'),beforeRefund),'0.23')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','退款、源记录关联或资产回补不一致');
 return {state:'ready',transferFeeAndBothAssetDeltas:true,partialRefundAndRelation:true};
}
export async function runReimbursement(e:CaseEnvironment){
 await e.synchronize();await e.read('ledger.transfer.options',{},true);
 if(!e.optional('reimburse-source-a')){
  const result=await e.write('reimburse-sources','ledger.create',{bills:['0.5','0.75'].map((money,index)=>({bookId:e.known('book'),type:5,categoryId:e.known('expense-category'),assetId:e.known('cash-a'),enteredMoney:money,fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'待报销'+index}))});
  const ids=result.items.filter(item=>item.state==='succeeded').map(item=>item.id);if(ids.length!==2)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','两笔待报销账单未逐项确认');e.remember('reimburse-source-a','bill',ids[0]!);e.remember('reimburse-source-b','bill',ids[1]!);
 }
 await e.synchronize();const originals=await Promise.all(['reimburse-source-a','reimburse-source-b'].map(alias=>e.read('ledger.detail',{id:e.known(alias)}))),before=e.checkpoint('reimburse-balance',await assetMoney(e,'cash-b'));
 const result=await e.write('reimburse-both','ledger.reimburse',{bills:originals.map(bill=>({id:bill.id,expectedVersion:bill.editVersion})),assetId:e.known('cash-b'),money:'1.25',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'两笔报销',tagIds:[e.known('tag')]});
 for(const [index,id]of Object.values(result.idMap??{}).entries())e.remember('reimburse-child-'+index,'bill',id);
 await e.synchronize();const sources=await Promise.all(originals.map(bill=>e.read('ledger.detail',{id:bill.id})));
 if(sources.some(bill=>!bill.reimbursementIds.length)||compareMoney(subtractMoney(await assetMoney(e,'cash-b'),before),'1.25')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','报销源关系或到账资产不一致');
 await e.write('reimburse-cancel','ledger.cancelReimbursement',{bills:sources.map(bill=>({id:bill.id,expectedVersion:bill.editVersion}))});
 const cancelled=await Promise.all(originals.map(bill=>e.read('ledger.detail',{id:bill.id})));
 if(cancelled.some(bill=>bill.reimbursementIds.length)||compareMoney(await assetMoney(e,'cash-b'),before)!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','取消报销后的关系清除或资产回退不一致');
 return {state:'ready',twoSourceReimbursement:true,cancelAndAssetRollback:true};
}
