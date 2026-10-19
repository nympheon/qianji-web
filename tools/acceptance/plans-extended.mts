import {DomainError} from '../../src/shared/errors';
import {compareMoney} from '../../src/shared/numbers';
import {repeatKey} from '../../src/features/repeat/source';
import {installmentKey} from '../../src/features/installments/source';
import {createdBill} from './ledger.mts';
import type {RepeatFields} from '../../src/features/repeat/contract';
import type {RemainderMode} from '../../src/features/installments/contract';
import type {CaseEnvironment} from './cases.mts';
const check=(ok:unknown,message:string)=>{if(!ok)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH',message);};
const one=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);check(ids.length===1,'计划缺少唯一新增ID');return ids[0]!;};
const query={sort:0 as const,ascending:false};
async function repeat(e:CaseEnvironment,label:string){e.invalidateSource(repeatKey());const row=(await e.read('repeat.list',query)).items.find(row=>row.id===e.known(label));check(row?.fields,'测试周期缺少完整配置');return row!;}
async function installment(e:CaseEnvironment,label:string){e.invalidateSource(installmentKey());const row=(await e.read('installments.list',query)).items.find(row=>row.id===e.known(label));check(row,'测试分期未回拉');return row!;}
export async function runRepeatExtended(e:CaseEnvironment){
 await e.synchronize();await e.read('ledger.transfer.options',{},true);
 const rules:RepeatFields['repeat'][]=[{type:'day',values:[]},{type:'week',values:['1','7']},{type:'month',values:['291','301','32']},{type:'year',values:['2-29','12-31']},{type:'workday',values:[]},{type:'bystep',values:['2']}];
 for(const [index,rule]of rules.entries()){
  const type=([0,1,2,3,5,0] as const)[index]!,label='repeat-extended-'+rule.type,foreign=index===5;
  const fields:RepeatFields={type,bookId:e.known('book'),categoryId:[2,3].includes(type)?null:e.known(type===1?'income-category':'expense-category'),fromAssetId:e.known(foreign?'cash-usd':'cash-a'),targetAssetId:type===2?e.known('cash-b'):type===3?e.known('installment-card'):null,enteredMoney:'1',fee:'0',startDate:'2026-12-31',time:'12:30',repeat:rule,end:index%2?{kind:'date',date:'2028-12-31'}:{kind:'count',count:2},remark:e.prefix+label,tagIds:[e.known('tag')],images:[e.known('image-bill')],countInStatistics:false,countInBudget:false,currency:foreign?{srcSymbol:'USD',srcValue:'1',targetSymbol:'USD',targetValue:'1',baseSymbol:'CNY',baseValue:'7'}:null};
  await e.phase(label+'-create',async()=>{e.remember(label,'repeat',one(await e.write(label+'-create','repeat.submit',{mode:'create',fields})));const row=await repeat(e,label);check(row.type===type&&row.count===0&&row.fields!.repeat.type===rule.type&&row.fields!.images.includes(e.known('image-bill'))&&!row.fields!.countInBudget&&!row.fields!.countInStatistics,'周期类型、规则、图片或标记未保存');});
  await e.phase(label+'-edit',async()=>{const row=await repeat(e,label),currency=foreign?{...fields.currency!,srcValue:'2',targetValue:'2',baseValue:'14'}:null;await e.write(label+'-edit','repeat.submit',{mode:'edit',id:row.id,expectedVersion:row.editVersion,changes:{enteredMoney:'2',currency,remark:e.prefix+label+'已改',countInStatistics:true,countInBudget:true}});const after=await repeat(e,label);check(compareMoney(after.fields!.enteredMoney,'2')===0&&after.fields!.countInStatistics&&after.fields!.countInBudget&&after.fields!.repeat.type===rule.type&&after.fields!.images.includes(e.known('image-bill')),'周期财务编辑未保留规则和图片');});
  await e.phase(label+'-delete',async()=>{const row=await repeat(e,label);await e.write(label+'-delete','repeat.delete',{id:row.id,expectedVersion:row.editVersion});e.invalidateSource(repeatKey());check(!(await e.read('repeat.list',query)).items.some(item=>item.id===row.id),'周期删除未回拉');});
 }
 return {state:'ready',sixRulesFiveBillTypesImagesFlagsFinancialEditAndForeignHistory:true};
}
export async function runRepeatNativeCurrency(e:CaseEnvironment){
 await e.phase('repeat-fx-dropped-cleanup',async()=>{
  const old=await e.write('repeat-extended-bystep-create','repeat.submit',{},['REPEAT_CURRENCY_NOT_SAVED']);
  e.remember('repeat-fx-dropped','repeat',one(old));const row=await repeat(e,'repeat-fx-dropped');await e.write('repeat-fx-dropped-delete','repeat.delete',{id:row.id,expectedVersion:row.editVersion});
 });
 const label='repeat-native-usd';
 await e.phase(label+'-create',async()=>{e.remember(label,'repeat',one(await e.write(label+'-create','repeat.submit',{mode:'create',fields:{type:0,bookId:e.known('book'),categoryId:e.known('expense-category'),fromAssetId:e.known('cash-usd'),enteredMoney:'1',startDate:'2026-12-31',repeat:{type:'bystep',values:['2']},end:{kind:'date',date:'2028-12-31'},remark:e.prefix+label}})));const row=await repeat(e,label);check(row.fields!.fromAssetId===e.known('cash-usd')&&row.fields!.currency===null&&row.fields!.repeat.values[0]==='2','按原生资产币种创建的周期未回拉');});
 await e.phase(label+'-edit',async()=>{const row=await repeat(e,label);await e.write(label+'-edit','repeat.submit',{mode:'edit',id:row.id,expectedVersion:row.editVersion,changes:{enteredMoney:'2',fee:'-0.1',remark:e.prefix+label+'已改'}});check(compareMoney((await repeat(e,label)).fields!.enteredMoney,'2')===0,'原生外币周期金额编辑未回拉');});
 await e.phase(label+'-delete',async()=>{const row=await repeat(e,label);await e.write(label+'-delete','repeat.delete',{id:row.id,expectedVersion:row.editVersion});e.invalidateSource(repeatKey());check(!(await e.read('repeat.list',query)).items.some(item=>item.id===row.id),'原生外币周期删除未回拉');});
 return {state:'ready',nativeForeignAssetAmountNoPresetExchangeSnapshot:true,priorDroppedSettingFailedAndKnownTestTaskDeleted:true};
}
export async function runPlanBinding(e:CaseEnvironment,kind:'repeat'|'installments'){
 await e.synchronize();const label='binding-'+kind;
 await e.phase(label+'-setup',async()=>{
  if(kind==='repeat')e.remember(label,'repeat',one(await e.write(label+'-create','repeat.submit',{mode:'create',fields:{type:0,bookId:e.known('book'),categoryId:e.known('expense-category'),fromAssetId:e.known('cash-a'),enteredMoney:'0.01',startDate:'2026-12-31',repeat:{type:'day',values:[]},end:{kind:'count',count:2},remark:e.prefix+label}})));
  else e.remember(label,'installment',one(await e.write(label+'-create','installments.create',{name:e.prefix+label,bookId:e.known('book'),assetId:e.known('installment-card'),categoryId:e.known('expense-category'),totalMoney:'0.03',totalFee:'0',totalCount:3,firstDate:'2026-12-31'})));
  const row=kind==='repeat'?await repeat(e,label):await installment(e,label);check(row.packId,'测试计划缺少分组');e.remember(label+'-pack','pack',row.packId!);
  e.remember(label+'-bill','bill',createdBill(await e.write(label+'-bill','ledger.create',{bills:[{bookId:e.known('book'),type:0,categoryId:e.known('expense-category'),assetId:e.known(kind==='repeat'?'cash-a':'installment-card'),enteredMoney:'0.01',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+label}]})));await e.synchronize();
 });
 for(const bound of [true,false])await e.phase(label+'-'+bound,async()=>{await e.write(label+'-'+bound,kind==='repeat'?'repeat.setBillBinding':'installments.setBillBinding',{planId:e.known(label),packId:e.known(label+'-pack'),billId:e.known(label+'-bill'),bound});await e.synchronize();check(((await e.read('ledger.detail',{id:e.known(label+'-bill')})).packId===e.known(label+'-pack'))===bound,'账单关联目标状态未回拉');});
 await e.phase(label+'-cleanup',async()=>{const bill=await e.read('ledger.detail',{id:e.known(label+'-bill')});await e.write(label+'-bill-delete','ledger.delete',{bills:[{id:bill.id,expectedVersion:bill.editVersion}]});const row=kind==='repeat'?await repeat(e,label):await installment(e,label);await e.write(label+'-delete',kind==='repeat'?'repeat.delete':'installments.delete',{id:row.id,expectedVersion:row.editVersion});await e.synchronize();});
 return {state:'ready',bindAndUnbindExistingTestBill:true,kind};
}
export async function runInstallmentModes(e:CaseEnvironment,remainder:RemainderMode){
 await e.synchronize();for(const feePlacement of ['ave','first','last'] as const){const label='installment-mode-'+remainder+'-'+feePlacement;
  await e.phase(label+'-create',async()=>{const input={name:e.prefix+label,bookId:e.known('book'),assetId:e.known('installment-card'),categoryId:e.known('expense-category'),totalMoney:'3.01',totalFee:'0.11',totalCount:3,firstDate:'2026-12-31',remainder,feePlacement,images:[e.known('image-bill')],tagIds:[e.known('tag')],countInBudget:false,countInStatistics:false};e.remember(label,'installment',one(await e.write(label+'-create','installments.create',input)));const row=await installment(e,label);check(row.remainder===remainder&&row.feePlacement===feePlacement&&row.count===0&&row.images.includes(e.known('image-bill'))&&compareMoney(row.totalMoney,'3.01')===0&&compareMoney(row.totalFee,'0.11')===0,'分期尾差、费用、图片或原始进度未回拉');});
  await e.phase(label+'-delete',async()=>{const row=await installment(e,label);await e.write(label+'-delete','installments.delete',{id:row.id,expectedVersion:row.editVersion});e.invalidateSource(installmentKey());check(!(await e.read('installments.list',query)).items.some(item=>item.id===row.id),'测试分期删除未回拉');});
 }return {state:'ready',remainder,allThreeFeePlacementsImagesTagsFlags:true};
}
