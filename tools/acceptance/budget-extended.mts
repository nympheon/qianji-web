import {DomainError} from '../../src/shared/errors';
import {compareMoney} from '../../src/shared/numbers';
import {budgetKey} from '../../src/features/budget/source';
import {bookListKey} from '../../src/features/books/source';
import type {CaseEnvironment} from './cases.mts';
const check=(value:unknown,message:string)=>{if(!value)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH',message);};
const one=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);check(ids.length===1,'预算测试资源缺少唯一ID');return ids[0]!;};
export async function runBudgetExtended(e:CaseEnvironment,native=false){
 const label=native?'budget-native-extended':'budget-extended';await e.phase(label+'-setup',async()=>{
  e.remember(label,'book',one(await e.write(label+'-book','books.submit',{mode:'create',type:-1,name:e.prefix+(native?'预算正数':'预算补验'),range:'m15'})));await e.synchronize();
  const categories=await e.read('categories.list',{bookId:e.known(label),type:0}),parent=categories.items.find(row=>row.parentId===null);check(parent,'新测试账本缺少分类');e.remember(label+'-parent','category',parent!.id);
  for(const suffix of ['a','b'])e.remember(label+'-'+suffix,'category',one(await e.write(label+'-'+suffix,'categories.submit',{mode:'create',bookId:e.known(label),type:0,name:e.prefix+'预算子'+suffix,parentId:parent!.id,icon:parent!.icon})));await e.synchronize();
 });
 const query={bookId:e.known(label),date:{kind:'month' as const,year:2030,month:5},range:'m15',zone:'Asia/Shanghai'},read=async()=>{e.invalidateSource(budgetKey(query));return e.read('budget.list',query,true);};
 await e.phase(label+'-nested',async()=>{const before=await read();await e.write(label+'-nested','budget.submit',{...query,expectedVersion:before.editVersion,changes:[{categoryId:null,limit:'1'},{categoryId:e.known(label+'-parent'),limit:'2'},{categoryId:e.known(label+'-a'),limit:'3'},{categoryId:e.known(label+'-b'),limit:'4'}]});const after=await read();for(const [categoryId,limit]of [[null,'7'],[e.known(label+'-parent'),'7'],[e.known(label+'-a'),'3'],[e.known(label+'-b'),'4']] as const)check(after.configurations.some(row=>row.categoryId===categoryId&&compareMoney(row.limit,limit)===0),'自定义周期父子预算归一未回拉');});
 await e.phase(label+'-floor',async()=>{const before=await read();await e.write(label+'-floor','budget.submit',{...query,expectedVersion:before.editVersion,changes:[{categoryId:null,limit:'0'},{categoryId:e.known(label+'-parent'),limit:'1'}]});const after=await read();check(after.configurations.some(row=>row.categoryId===null&&compareMoney(row.limit,'7')===0)&&after.configurations.some(row=>row.categoryId===e.known(label+'-parent')&&compareMoney(row.limit,'7')===0),'总预算或父预算错误低于二级预算');});
 await e.phase(label+'-clear',async()=>{const before=await read();await e.write(label+'-clear','budget.submit',{...query,expectedVersion:before.editVersion,changes:[{categoryId:null,limit:native?'7':'0'},...['parent','a','b'].map(suffix=>({categoryId:e.known(label+'-'+suffix),limit:'0'}))]});const after=await read();check(after.configurations.every(row=>row.categoryId===null&&compareMoney(row.limit,native?'7':'0')===0),'预算清空后官方仍存在正数额度');});
 await e.phase(label+'-delete',async()=>{e.invalidateSource(bookListKey);const book=(await e.read('books.list',{includeHidden:true})).items.find(row=>row.id===e.known(label));check(book,'预算测试账本缺失');await e.write(label+'-delete','books.delete',{id:book!.id,expectedVersion:book!.editVersion});});
 return {state:'ready',customMonth15NestedParentAndTotalFloorAndCategoryClear:true,positiveTotalRetained:native};
}
export async function runBudgetBookRanges(e:CaseEnvironment){
 for(const range of ['q','all']){
  const label='budget-book-range-'+range;await e.phase(label+'-create',async()=>{e.remember(label,'book',one(await e.write(label+'-create','books.submit',{mode:'create',type:-1,name:e.prefix+'预算'+range,range})));await e.synchronize();});
  for(const kind of ['month','year'] as const)await e.phase(label+'-'+kind,async()=>{const query={bookId:e.known(label),date:kind==='month'?{kind,year:2032,month:5}:{kind,year:2032},range,zone:'Asia/Shanghai'},read=async()=>{e.invalidateSource(budgetKey(query));return e.read('budget.list',query,true);},before=await read(),limit=kind==='month'?'10':'20';await e.write(label+'-'+kind,'budget.submit',{...query,expectedVersion:before.editVersion,changes:[{categoryId:null,limit}]});const after=await read();check(after.configurations.some(row=>row.categoryId===null&&compareMoney(row.limit,limit)===0),'账本显示周期下的独立月/年预算未回拉');});
  await e.phase(label+'-delete',async()=>{e.invalidateSource(bookListKey);const book=(await e.read('books.list',{includeHidden:true})).items.find(row=>row.id===e.known(label));check(book,'测试预算账本缺失');await e.write(label+'-delete','books.delete',{id:book!.id,expectedVersion:book!.editVersion});});
 }
 return {state:'ready',quarterAndAllTimeBookDisplayKeepIndependentMonthlyAndYearlyBudgets:true};
}
