import {DomainError} from '../../src/shared/errors';
import {compareMoney,subtractMoney} from '../../src/shared/numbers';
import {assetInfoKey} from '../../src/features/assets/service';
import type {CaseEnvironment} from './cases.mts';
export async function runDebt(e:CaseEnvironment){
 await e.synchronize();await e.read('debt.options',{},true);
 const cashId=e.known('cash-a'),cash=async()=>{e.invalidateSource(assetInfoKey(cashId));const result=await e.read('assets.detail',{id:cashId},true);if(!result.asset)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试现金资产缺失');return result.asset.money;};
 const before=e.checkpoint('debt-cash-before',await cash());
 for(const direction of ['borrow','lend'] as const){
  const alias='debt-'+direction;
  if(!e.optional(alias)){
   const result=await e.write(alias+'-create','debt.create',{direction,name:e.prefix+(direction==='borrow'?'测试借入':'测试借出'),principal:'2',bookId:e.known('book'),aboutAssetId:cashId,startDate:'2026-10-19',endDate:null,inCount:false,remark:e.prefix+'借贷本金'});
   const mapping=Object.entries(result.idMap),asset=mapping.find(([key])=>!key.endsWith(':principal')),bill=mapping.find(([key])=>key.endsWith(':principal'));if(!asset||!bill)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','借贷回执未分别证明资产和初始本金账单');e.remember(alias,'asset',asset[1]);e.remember(alias+'-initial','bill',bill[1]);
  }
  const id=e.known(alias),detail=async()=>{e.invalidateSource(assetInfoKey(id));const result=await e.read('assets.detail',{id},true);if(!result.asset)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试借贷详情缺失');return result.asset;};
  let asset=await detail();if(compareMoney(asset.money,direction==='borrow'?'-2':'2'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','初始借贷符号或余额不符');
  await e.write(alias+'-append','debt.appendPrincipal',{id,expectedVersion:asset.editVersion,principal:'1',bookId:e.known('book'),aboutAssetId:cashId,timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'追加本金'});await e.synchronize();asset=await detail();if(compareMoney(asset.money,direction==='borrow'?'-3':'3'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','追加本金未按原生方向更新');
  await e.write(alias+'-pay','debt.pay',{id,expectedVersion:asset.editVersion,principal:'1',interest:'0.1',bookId:e.known('book'),aboutAssetId:cashId,timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'本金及利息'});await e.synchronize();asset=await detail();if(compareMoney(asset.money,direction==='borrow'?'-2':'2'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','本金还款或收款未更新借贷余额');
  await e.write(alias+'-finish','assets.setFinished',{id,finished:true,date:'2026-10-19'});if(!(await detail()).finished)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','借贷结清状态未生效');
  await e.write(alias+'-unfinish','assets.setFinished',{id,finished:false});if((await detail()).finished)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','借贷恢复未结清未生效');
 }
 if(compareMoney(subtractMoney(await cash(),before),'0'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','对称借入/借出及本息的现金净变化不为零');
 return {state:'ready',borrowLendAppendPayInterestFinishUnfinish:true,initialBillsNotDuplicated:true};
}
