import {DomainError} from '../../src/shared/errors';
import {compareMoney,addMoney,subtractMoney} from '../../src/shared/numbers';
import {assetInfoKey} from '../../src/features/assets/service';
import {createdBill} from './ledger.mts';
import type {CaseEnvironment} from './cases.mts';
const check=(ok:unknown,message:string)=>{if(!ok)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH',message);};
const one=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);check(ids.length===1,'新增缺少唯一官方ID');return ids[0]!;};
async function asset(e:CaseEnvironment,alias:string){const id=e.known(alias);e.invalidateSource(assetInfoKey(id));const result=await e.read('assets.detail',{id},true);check(result.asset,'测试资产未载入');return result.asset!;}
async function balances(e:CaseEnvironment,key:string,aliases:string[]){const values:Record<string,string>={};for(const alias of aliases)values[alias]=e.checkpoint(key+':'+alias,(await asset(e,alias)).money);return values;}
async function checkBalances(e:CaseEnvironment,values:Record<string,string>){for(const [alias,expected]of Object.entries(values))check(compareMoney((await asset(e,alias)).money,expected)===0,'测试资产余额未与预期一致：'+alias);}
export async function runReimbursable(e:CaseEnvironment){
 await e.synchronize();const bookId=e.known('book'),before=await balances(e,'mark-before',['cash-a']);
 await e.phase('mark-setup',async()=>{e.remember('mark-bill','bill',createdBill(await e.write('mark-bill','ledger.create',{bills:[{bookId,type:0,categoryId:e.known('expense-category'),assetId:e.known('cash-a'),enteredMoney:'0.21',fee:'-0.01',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'报销标记测试'}]})));await e.synchronize();});
 for(const desired of [true,false])await e.phase('mark-'+desired,async()=>{const row=await e.read('ledger.detail',{id:e.known('mark-bill')});await e.write('mark-'+desired,'ledger.setReimbursable',{bills:[{id:row.id,expectedVersion:row.editVersion}],reimbursable:desired});await e.synchronize();const after=await e.read('ledger.detail',{id:row.id});check(after.type===(desired?5:0)&&compareMoney(after.money,'0.2')===0,'待报销标记切换未保留原金额');await checkBalances(e,{'cash-a':subtractMoney(before['cash-a']!,'0.2')});});
 await e.phase('mark-cleanup',async()=>{const row=await e.read('ledger.detail',{id:e.known('mark-bill')});await e.write('mark-delete','ledger.delete',{bills:[{id:row.id,expectedVersion:row.editVersion}]});await e.synchronize();await checkBalances(e,before);});return {state:'ready',reimbursableBothTargetsPreserveMoneyAndBalance:true};
}
export async function runForeignTransfers(e:CaseEnvironment){
 await e.synchronize();const types=await e.read('assets.types',{}),card=types.items.find(row=>row.type===2);check(card,'缺少官方信用卡类型');
 await e.phase('fx-card-setup',async()=>{e.remember('extended-usd-card','asset',one(await e.write('extended-usd-card','assets.submit',{mode:'create',fields:{name:e.prefix+'外币验收信用卡',type:2,subtype:card!.subtype,currency:'USD',money:'0',inCount:false,credit:{limit:'100',statementDay:1,paymentDay:10,statementIncludesPrevious:false}}})));check((await asset(e,'extended-usd-card')).currency==='USD','USD信用卡币种未回拉');});
 const before=await balances(e,'fx-transfer-before',['cash-a','cash-b','cash-usd','extended-usd-card']),bookId=e.known('book');
 for(const [label,action,from,target,entered,fee,targetMoney,baseValue,nextEntered,nextFee,nextTarget,nextBase]of [
  ['fx-transfer','ledger.transfer','cash-usd','cash-b','1','0.1','6.3','6.3','2','0.2','12.6','12.6'],
  ['fx-card','ledger.repayCard','cash-a','extended-usd-card','7','0','1','7','14','0.7','1.9','13.3'],
 ] as const){
  const sourceCurrency=from==='cash-usd'?'USD':'CNY',targetCurrency=target==='cash-b'?'CNY':'USD';
  const currency=(srcValue:string,targetValue:string,baseValue:string)=>({srcSymbol:sourceCurrency,srcValue,targetSymbol:targetCurrency,targetValue,baseSymbol:'CNY',baseValue});
  await e.phase(label+'-create',async()=>{
   e.remember(label,'bill',createdBill(await e.write(label+'-create',action,{mode:'create',bookId,fromAssetId:e.known(from),targetAssetId:e.known(target),enteredMoney:entered,fee,timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+label,currency:currency(entered,targetMoney,baseValue)})));await e.synchronize();
   const row=await e.read('ledger.detail',{id:e.known(label)});check(row.currency?.srcSymbol===sourceCurrency&&compareMoney(row.currency.targetValue,targetMoney)===0,'外币转账/还款历史金额未回拉');await checkBalances(e,{[from]:subtractMoney(before[from]!,entered),[target]:addMoney(before[target]!,targetMoney)});
  });
  await e.phase(label+'-edit',async()=>{
   const row=await e.read('ledger.detail',{id:e.known(label)});await e.write(label+'-edit',action,{mode:'edit',id:row.id,expectedVersion:row.editVersion,changes:{enteredMoney:nextEntered,fee:nextFee,currency:currency(nextEntered,nextTarget,nextBase),remark:e.prefix+label+'已改'}});await e.synchronize();const after=await e.read('ledger.detail',{id:row.id});check(after.currency&&compareMoney(after.currency.srcValue,nextEntered)===0&&compareMoney(after.currency.targetValue,nextTarget)===0,'外币转账/还款编辑金额未回拉');await checkBalances(e,{[from]:subtractMoney(before[from]!,nextEntered),[target]:addMoney(before[target]!,nextTarget)});
  });
  await e.phase(label+'-delete',async()=>{const row=await e.read('ledger.detail',{id:e.known(label)});await e.write(label+'-delete',action,{mode:'delete',id:row.id,expectedVersion:row.editVersion});await e.synchronize();await checkBalances(e,before);});
 }
 return {state:'ready',foreignTransferAndCardCreateEditDeleteHistoricalAmountsAndRealBalances:true};
}
export async function runDebtExtended(e:CaseEnvironment){
 await e.synchronize();const before=await balances(e,'extended-debt-before',['cash-a']);
 for(const direction of ['borrow','lend'] as const){const label='extended-debt-'+direction;
  await e.phase(label+'-create',async()=>{
   const result=await e.write(label+'-create','debt.create',{direction,name:e.prefix+(direction==='borrow'?'补验借入':'补验借出'),principal:'0.2',bookId:e.known('book'),aboutAssetId:e.known('cash-a'),startDate:'2026-10-19',endDate:null,inCount:false,remark:e.prefix+'本金编辑',images:[e.known('image-bill')]});const entries=Object.entries(result.idMap),principal=entries.find(([key])=>key.endsWith(':principal')),debt=entries.find(([key])=>!key.endsWith(':principal'));check(principal&&debt,'借贷资产和初始账单未分别确认');e.remember(label,'asset',debt![1]);e.remember(label+'-initial','bill',principal![1]);await e.synchronize();const row=await e.read('ledger.detail',{id:principal![1]});check(row.images.includes(e.known('image-bill')),'借贷初始图片未回拉');
  });
  await e.phase(label+'-edit',async()=>{const row=await e.read('ledger.detail',{id:e.known(label+'-initial')});await e.write(label+'-edit','debt.editPrincipal',{id:row.id,expectedVersion:row.editVersion,changes:{principal:'0.3',remark:e.prefix+'本金编辑已改'}});await e.synchronize();check(compareMoney((await asset(e,label)).money,direction==='borrow'?'-0.3':'0.3')===0,'初始本金编辑未更新借贷余额');const after=await e.read('ledger.detail',{id:row.id});check(compareMoney(after.money,'0.3')===0,'本金账单编辑未回拉');});
  await e.phase(label+'-interest',async()=>{const debt=await asset(e,label),result=await e.write(label+'-interest','debt.pay',{id:debt.id,expectedVersion:debt.editVersion,principal:'0',interest:'0.01',bookId:e.known('book'),aboutAssetId:e.known('cash-a'),timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'仅利息'});await e.synchronize();check(compareMoney((await asset(e,label)).money,direction==='borrow'?'-0.3':'0.3')===0,'仅利息不应修改本金余额');const ids=result.affectedIds.filter(id=>/^[1-9]\d+$/.test(id));check(ids.length===1,'仅利息应有一笔独立账单');const row=await e.read('ledger.detail',{id:ids[0]!});check(row.type===(direction==='borrow'?10:11)&&compareMoney(row.money,'0.01')===0,'仅利息原生账单未回拉');});
  await e.phase(label+'-delete',async()=>{const debt=await asset(e,label);await e.write(label+'-delete','assets.delete',{id:debt.id,expectedVersion:debt.editVersion});await e.synchronize();});
 }
 await checkBalances(e,before);return {state:'ready',borrowAndLendInitialImagePrincipalEditInterestOnlyAndDelete:true,symmetricCashEffectsNetZero:true};
}
