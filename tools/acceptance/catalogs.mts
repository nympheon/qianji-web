import { DomainError } from '../../src/shared/errors';
import { compareMoney } from '../../src/shared/numbers';
import type { CaseEnvironment } from './cases.mts';
import { budgetKey } from '../../src/features/budget/source';
const idOf=(operation:Awaited<ReturnType<CaseEnvironment['write']>>)=>{
 const ids=Object.values(operation.idMap??{});if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','目录新建缺少唯一官方ID');return ids[0]!;
};
export async function runCatalogs(e:CaseEnvironment){
 const bookId=e.known('book');
 if(!e.optional('category-parent'))e.remember('category-parent','category',idOf(await e.write('category-parent','categories.submit',{mode:'create',bookId,type:0,name:e.prefix+'一级',parentId:null})));
 if(!e.optional('category-child'))e.remember('category-child','category',idOf(await e.write('category-child','categories.submit',{mode:'create',bookId,type:0,name:e.prefix+'二级',parentId:e.known('category-parent')})));
 let tree=await e.read('categories.list',{bookId,type:0});
 const child=tree.items.find(item=>item.id===e.known('category-child'));if(!child||child.level!==2||child.parentId!==e.known('category-parent'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类层级回拉不一致');
 await e.write('category-child-rename','categories.submit',{mode:'edit',bookId,type:0,id:child.id,expectedVersion:child.editVersion,name:e.prefix+'二级改名'});
 tree=await e.read('categories.list',{bookId,type:0});if(tree.items.find(item=>item.id===child.id)?.name!==e.prefix+'二级改名')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类改名回拉不一致');
 if(!e.optional('tag-group'))e.remember('tag-group','tagGroup',idOf(await e.write('tag-group','tags.submitGroup',{mode:'create',name:e.prefix+'组'})));
 if(!e.optional('tag'))e.remember('tag','tag',idOf(await e.write('tag-create','tags.submitTag',{mode:'create',name:e.prefix+'标签',groupId:e.known('tag-group'),color:'E8AE51'})));
 let tags=await e.read('tags.list',{includeArchived:true});if(tags.items.find(item=>item.id===e.known('tag'))?.groupId!==e.known('tag-group'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','标签分组回拉不一致');
 await e.write('tag-archive','tags.setArchived',{id:e.known('tag'),archived:true});tags=await e.read('tags.list',{includeArchived:true});if(!tags.items.find(item=>item.id===e.known('tag'))?.archived)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','标签归档未生效');
 await e.write('tag-restore','tags.setArchived',{id:e.known('tag'),archived:false});tags=await e.read('tags.list',{includeArchived:true});if(tags.items.find(item=>item.id===e.known('tag'))?.archived!==false)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','标签恢复未生效');
 return {state:'ready',categoryHierarchy:true,tagGroupAndArchive:true};
}
export async function runBudget(e:CaseEnvironment){
 await e.synchronize();const date=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),query={bookId:e.known('book'),date:{kind:'month' as const,year:Number(date.slice(0,4)),month:Number(date.slice(5,7))},range:'',zone:'Asia/Shanghai'};
 const before=await e.read('budget.list',query);
 await e.write('budget-month','budget.submit',{...query,expectedVersion:before.editVersion,changes:[{categoryId:null,limit:'10'},{categoryId:e.known('expense-category'),limit:'5'}]});
 e.invalidateSource(budgetKey(query));
 const after=await e.read('budget.list',query),total=after.configurations.find(item=>item.categoryId===null),category=after.configurations.find(item=>item.categoryId===e.known('expense-category'));
 if(!total||!category||compareMoney(total.limit,'10')!==0||compareMoney(category.limit,'5')!==0)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','总预算或分类预算回拉不一致');
 return {state:'ready',monthlyTotalAndCategory:true};
}
export async function runCatalogBatch(e:CaseEnvironment){
 const bookId=e.known('book'),icons=await e.read('categories.icons',{});
 if(icons.items.length<2)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','官方图标目录不足两项');
 if(!e.optional('batch-category-a')){
  const result=await e.write('category-batch','categories.submitMany',{bookId,type:0,parentId:null,items:[{name:e.prefix+'批量一',icon:icons.items[0]!.icon},{name:e.prefix+'批量二',icon:icons.items[1]!.icon}]});
  const ids=Object.values(result.idMap??{});if(ids.length!==2)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','批量分类未返回两个确定ID');
  e.remember('batch-category-a','category',ids[0]!);e.remember('batch-category-b','category',ids[1]!);
 }
 const rows=(await e.read('categories.list',{bookId,type:0})).items;
 for(const alias of ['batch-category-a','batch-category-b'])if(!rows.some(row=>row.id===e.known(alias)&&row.bookId===bookId&&row.icon))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','批量分类未在官方列表中出现');
 return {state:'ready',batchCategoriesAndOfficialIcons:true};
}
