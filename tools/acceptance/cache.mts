import {DomainError} from '../../src/shared/errors';
import {budgetKey} from '../../src/features/budget/source';
import {installmentKey} from '../../src/features/installments/source';
import {repeatKey} from '../../src/features/repeat/source';
import type {CaseEnvironment} from './cases.mts';
export async function runCache(e:CaseEnvironment,readOnly=false){
 await e.synchronize();
 const routes=[];for(const route of ['main','backup','overseas'] as const){const result=await e.read('connection.testRoute',{route});routes.push({route:result.route,status:result.status,error:result.error,latencyMs:result.latencyMs});}
 const repeatQuery={sort:0 as const,ascending:false};e.invalidateSource(repeatKey(repeatQuery));const repeats=await Promise.all([e.read('repeat.list',repeatQuery),e.read('repeat.list',repeatQuery)]);if(repeats.some(list=>list.items.length))throw new DomainError('ACCEPTANCE_PREREQUISITE','本例要求测试周期已删除且官方目录为空');
 e.invalidateSource(installmentKey());await Promise.all([e.read('installments.list',repeatQuery),e.read('installments.list',repeatQuery)]);
 const query={bookId:e.known('book'),date:{kind:'year' as const,year:readOnly?2031:2027},range:'',zone:'Asia/Shanghai'};e.invalidateSource(budgetKey(query));const first=await e.read('budget.list',query,true);await e.read('budget.list',query,true);if(first.configurations.length)throw new DomainError('ACCEPTANCE_PREREQUISITE','本例要求测试账本未来年度预算为空');
 if(readOnly)return {state:'ready',routes,emptyRepeatAndInstallmentReads:2,emptyBudgetReads:2};
 await e.write('budget-year','budget.submit',{...query,expectedVersion:first.editVersion,changes:[{categoryId:null,limit:'12'}]});e.invalidateSource(budgetKey(query));const after=await e.read('budget.list',query,true);if(!after.configurations.some(item=>item.categoryId===null&&item.limit==='12'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','年度预算未回拉');
 await e.write('budget-year-cancel','budget.submit',{...query,expectedVersion:after.editVersion,changes:[{categoryId:null,limit:'0'}]});e.invalidateSource(budgetKey(query));const canceled=await e.read('budget.list',query,true);if(canceled.configurations.some(item=>item.categoryId===null&&item.limit!=='0'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','年度预算取消未回拉');
 return {state:'ready',routes,emptyRepeatAndInstallmentReads:2,emptyBudgetReads:2,annualBudgetSetCancel:true};
}
export async function runBudgetNative(e:CaseEnvironment){
 await e.synchronize();const query={bookId:e.known('book'),date:{kind:'year' as const,year:2028},range:'',zone:'Asia/Shanghai'},read=async()=>{e.invalidateSource(budgetKey(query));return e.read('budget.list',query,true);};
 let plan=await read();await e.write('native-budget-create','budget.submit',{...query,expectedVersion:plan.editVersion,changes:[{categoryId:null,limit:'12'},{categoryId:e.known('expense-category'),limit:'5'}]});plan=await read();if(plan.configurations.length!==2)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','独立年度测试预算创建未回拉');
 await e.write('native-budget-cancel-category','budget.submit',{...query,expectedVersion:plan.editVersion,changes:[{categoryId:e.known('expense-category'),limit:'0'}]});plan=await read();if(plan.configurations.some(row=>row.categoryId!==null)||!plan.configurations.some(row=>row.categoryId===null&&row.limit==='12'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类预算移除或保留总预算不符');
 return {state:'ready',fullNativeCollectionPreservesUntouchedTotalAndRemovesCategory:true,totalCancellationStillUnverified:true};
}
