import { DomainError } from '../../src/shared/errors';
import { compareMoney } from '../../src/shared/numbers';
import type { CaseEnvironment } from './cases.mts';
const oneId=(operation:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(operation.idMap??{});if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','新建计划缺少唯一ID');return ids[0]!;};
const repeatQuery={sort:0 as const,ascending:false};
export async function runRepeat(e:CaseEnvironment,resumeAfterPause=false){
 await e.synchronize();await e.read('ledger.transfer.options',{},true);
 if(!e.optional('repeat-month-end')){
  const result=await e.write('repeat-create','repeat.submit',{mode:'create',fields:{type:0,bookId:e.known('book'),categoryId:e.known('expense-category'),fromAssetId:e.known('cash-a'),targetAssetId:null,enteredMoney:'1',fee:'0',startDate:'2026-12-31',time:'00:00',repeat:{type:'month',values:['32']},end:{kind:'count',count:2},remark:e.prefix+'月末周期',tagIds:[e.known('tag')],images:[],countInStatistics:true,countInBudget:true,currency:null}});e.remember('repeat-month-end','repeat',oneId(result));
 }
 let task=(await e.read('repeat.list',repeatQuery)).items.find(item=>item.id===e.known('repeat-month-end'));
 if(!task?.fields||task.fields.repeat.type!=='month'||!task.fields.repeat.values.includes('32')||task.fields.startDate!=='2026-12-31')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','月末周期配置回拉不一致');
 await e.write('repeat-resume-first','repeat.setPaused',{id:task.id,paused:false});
 task=(await e.read('repeat.list',repeatQuery)).items.find(item=>item.id===e.known('repeat-month-end'));if(task?.status!==1)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','周期恢复目标未生效');
 await e.write('repeat-pause','repeat.setPaused',{id:task.id,paused:true});
 task=(await e.read('repeat.list',repeatQuery)).items.find(item=>item.id===e.known('repeat-month-end'));if(task?.status!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','周期暂停目标未生效');
 if(resumeAfterPause){await e.write('repeat-resume-after-pause','repeat.setPaused',{id:task.id,paused:false});task=(await e.read('repeat.list',repeatQuery)).items.find(item=>item.id===e.known('repeat-month-end'));if(task?.status!==1)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','周期从暂停恢复未生效');}
 await e.write('repeat-edit','repeat.submit',{mode:'edit',id:task.id,expectedVersion:task.editVersion,changes:{remark:e.prefix+'周期改名'}});
 task=(await e.read('repeat.list',repeatQuery)).items.find(item=>item.id===e.known('repeat-month-end'));if(!task?.fields||task.fields.remark!==e.prefix+'周期改名'||task.fields.repeat.type!=='month')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','周期修改丢失规则或备注');
 await e.write('repeat-delete','repeat.delete',{id:task.id,expectedVersion:task.editVersion});
 if((await e.read('repeat.list',repeatQuery)).items.some(item=>item.id===task.id))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','测试周期删除未得到官方列表证明');
 return {state:'ready',monthEndAndCountLimit:true,pauseResumeEditDelete:true,executionNotTested:true};
}
export async function runSavings(e:CaseEnvironment){
 if(!e.optional('saving-custom')){
  const result=await e.write('saving-create','savings.submit',{mode:'create',fields:{name:e.prefix+'测试存钱',currency:'CNY',rule:{mode:'custom',startDate:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),time:'00:00',zone:'Asia/Shanghai',total:'10',endDate:null},remark:e.prefix+'手动进度'}});e.remember('saving-custom','saving',oneId(result));
 }
 let plan=(await e.read('savings.list',{})).items.find(item=>item.planId===e.known('saving-custom'));if(!plan||plan.currency!=='CNY'||plan.mode!=='custom'||compareMoney(plan.savedAmount,'0')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','新建存钱目标回拉不一致');
 if(!e.optional('saving-tx')){const result=await e.write('saving-deposit','savings.deposit',{planId:plan.planId,expectedCurrency:'CNY',amount:'1',remark:e.prefix+'进度存入',timeSec:Math.floor(Date.now()/60000)*60});e.remember('saving-tx','transaction',oneId(result));}
 plan=(await e.read('savings.list',{})).items.find(item=>item.planId===e.known('saving-custom'));const transaction=plan?.transactions.find(item=>item.transId===e.known('saving-tx'));
 if(!plan||!transaction||transaction.billId||compareMoney(plan.savedAmount,'1')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','仅记录进度的存入产生错误余额或账单');
 await e.write('saving-cancel','savings.cancelDeposit',{planId:plan.planId,transId:transaction.transId,expectedVersion:transaction.version});
 plan=(await e.read('savings.list',{})).items.find(item=>item.planId===e.known('saving-custom'));if(!plan||plan.transactions.some(item=>item.transId===transaction.transId)||compareMoney(plan.savedAmount,'0')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','撤销存入后交易或进度未回退');
 await e.write('saving-edit','savings.submit',{mode:'edit',planId:plan.planId,expectedVersion:plan.editVersion,changes:{remark:e.prefix+'存钱备注修改'}});
 plan=(await e.read('savings.list',{})).items.find(item=>item.planId===e.known('saving-custom'));if(plan?.fields?.remark!==e.prefix+'存钱备注修改')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','存钱备注修改未回拉');
 await e.write('saving-delete','savings.delete',{planId:plan.planId,deleteBills:false});
 if((await e.read('savings.list',{})).items.some(item=>item.planId===plan.planId))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','测试存钱计划删除未证明');
 return {state:'ready',customPlanAndProgressDeposit:true,cancelEditDelete:true};
}
export async function runNativeSavings(e:CaseEnvironment){
 const isolated:CaseEnvironment={...e,prefix:e.prefix+'N',optional:alias=>e.optional('native-'+alias),known:alias=>e.known('native-'+alias),remember:(alias,kind,id)=>e.remember('native-'+alias,kind,id),write:(step,action,input)=>e.write('native-'+step,action,input),read:(action,input,allow)=>e.read(action,input,action==='savings.list'||allow===true)};
 return runSavings(isolated);
}
export async function runRepeatWire(e:CaseEnvironment,label='wire'){
 const isolated:CaseEnvironment={...e,prefix:e.prefix+(label==='wire'?'W':'A'),optional:alias=>e.optional(label+'-'+alias),known:alias=>e.known(alias.startsWith('repeat-')?label+'-'+alias:alias),remember:(alias,kind,id)=>e.remember(label+'-'+alias,kind,id),write:(step,action,input)=>e.write(label+'-'+step,action,input)};
 return runRepeat(isolated,true);
}
