import {DomainError} from '../../src/shared/errors';
import {compareMoney} from '../../src/shared/numbers';
import {savingsKey} from '../../src/features/savings/source';
import type {CaseEnvironment} from './cases.mts';
const oneId=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','计划未返回唯一ID');return ids[0]!;};
export async function runSavingsModes(e:CaseEnvironment){
 const dates={startDate:'2026-12-31',time:'00:00',zone:'Asia/Shanghai'};
 for(const mode of ['fixedAmount','fixedAmount12','fixedAmount36','daily365','weekly52','reverseWeekly52'] as const){
  const alias='saving-mode-'+mode,rule=mode.startsWith('fixed')?{...dates,mode,amount:'1',...(mode==='fixedAmount'?{period:3,frequency:'month'}:{})}:{...dates,mode,initialAmount:mode==='reverseWeekly52'?'52':'1',increment:'1'};
  if(!e.optional(alias))e.remember(alias,'saving',oneId(await e.write(alias+'-create','savings.submit',{mode:'create',fields:{name:e.prefix+mode,currency:'CNY',rule}})));
  e.invalidateSource(savingsKey);const plan=(await e.read('savings.list',{},true)).items.find(plan=>plan.planId===e.known(alias));if(!plan?.fields||plan.mode!==mode||compareMoney(plan.savedAmount,'0'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','存钱模式、规则或新建进度未回拉');
  await e.write(alias+'-delete','savings.delete',{planId:plan.planId,deleteBills:false});
 }
 return {state:'ready',sixScheduledModesCreatedReadBackAndDeleted:true};
}
export async function runSavingsLinked(e:CaseEnvironment){
 await e.synchronize();await e.read('ledger.transfer.options',{},true);
 for(const [label,currency,amount,target,deleteBills] of [['cny','CNY','0.5','balance-asset',false],['usd','USD','1','cash-usd',true]] as const){
  const alias='linked-saving-'+label;
  if(!e.optional(alias))e.remember(alias,'saving',oneId(await e.write(alias+'-create','savings.submit',{mode:'create',fields:{name:e.prefix+'关联存钱'+label,currency,rule:{mode:'custom',startDate:'2026-10-19',time:'00:00',zone:'Asia/Shanghai',total:'10',endDate:null}}})));
  const planId=e.known(alias),billInfo={bookId:e.known('book'),outAssetId:e.known('cash-a'),inAssetId:e.known(target),tagIds:[e.known('tag')],...(currency==='USD'?{currency:{srcSymbol:'CNY',srcValue:'7',targetSymbol:'USD',targetValue:'1',baseSymbol:'CNY',baseValue:'7',srcFee:'0'}}:{})};
  const deposit=async(step:string)=>{const op=await e.write(alias+'-'+step,'savings.deposit',{planId,expectedCurrency:currency,amount,timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'关联存入'+step,billInfo});const ids=Object.entries(op.idMap),tx=ids.find(([key])=>key.endsWith(':transaction')),bill=ids.find(([key])=>key.endsWith(':bill'));if(!tx||!bill)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','存入交易和关联账单未分别确认');e.remember(alias+'-'+step+'-tx','transaction',tx[1]);e.remember(alias+'-'+step+'-bill','bill',bill[1]);return {tx:tx[1],bill:bill[1]};};
  const first=await deposit('first');await e.synchronize();e.invalidateSource(savingsKey);let plan=(await e.read('savings.list',{},true)).items.find(plan=>plan.planId===planId),tx=plan?.transactions.find(tx=>tx.transId===first.tx);if(!plan||!tx||tx.billId!==first.bill||compareMoney(plan.savedAmount,amount))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','计划进度与关联转账ID不符');
  await e.write(alias+'-cancel','savings.cancelDeposit',{planId,transId:tx.transId,expectedVersion:tx.version});await e.synchronize();const deleted=await e.read('ledger.list',{bookIds:[e.known('book')],limit:200});if(deleted.items.some(bill=>bill.id===first.bill))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','撤销存入后关联账单仍存在');
  const second=await deposit('second');await e.synchronize();await e.write(alias+'-delete','savings.delete',{planId,deleteBills});await e.synchronize();const remaining=await e.read('ledger.list',{bookIds:[e.known('book')],limit:200});if(remaining.items.some(bill=>bill.id===second.bill)===deleteBills)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','删除计划的保留/删除关联账单选择未兑现');
 }
 return {state:'ready',cnyAndForeignLinkedDepositCancelAndBothDeletePolicies:true};
}
