import {DomainError} from '../../src/shared/errors';
import {bookListKey} from '../../src/features/books/source';
import {categoryKey} from '../../src/features/categories/source';
import {tagCatalogKey} from '../../src/features/tags/source';
import {assetListKey} from '../../src/features/assets/service';
import type {CaseEnvironment} from './cases.mts';
const oneId=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','新资源缺少唯一回执ID');return ids[0]!;};
export async function runManagement(e:CaseEnvironment){
 await e.synchronize();
 if(!e.optional('empty-book'))e.remember('empty-book','book',oneId(await e.write('empty-book-create','books.submit',{mode:'create',type:-1,name:e.prefix+'空账本删除验收'})));
 const id=e.known('empty-book'),getBook=async()=>{e.invalidateSource(bookListKey);const value=(await e.read('books.list',{includeHidden:true})).items.find(book=>book.id===id);if(!value)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试空账本缺失');return value;};
 let book=await getBook();await e.write('empty-book-rename','books.submit',{mode:'edit',id,expectedVersion:book.editVersion,name:e.prefix+'空账本已改名'});book=await getBook();if(book.name!==e.prefix+'空账本已改名')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','账本改名未生效');
 for(const range of ['m15',''] as const){book=await getBook();await e.write('empty-book-range-'+(range||'natural'),'books.configure',{id,expectedVersion:book.editVersion,range});if((await getBook()).range!==range)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','业务周期未生效');}
 for(const visible of [false,true]){await e.write('empty-book-visible-'+visible,'books.setVisible',{id,visible});if((await getBook()).visible!==visible)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','账本隐藏恢复未生效');}
 const check=await e.read('books.deleteCheck',{id});if(check.blocked)throw new DomainError('ACCEPTANCE_DELETE_BLOCKED','空测试账本删除检查未通过');await e.write('empty-book-delete','books.delete',{id,expectedVersion:check.expectedVersion});e.invalidateSource(bookListKey);if((await e.read('books.list',{includeHidden:true})).items.some(book=>book.id===id))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','空测试账本删除未回拉');
 await e.read('assets.types',{});if(!e.optional('empty-asset'))e.remember('empty-asset','asset',oneId(await e.write('empty-asset-create','assets.submit',{mode:'create',fields:{name:e.prefix+'空资产删除验收',type:1,subtype:11,currency:'CNY',money:'0',inCount:false}})));
 const aid=e.known('empty-asset'),assetCheck=await e.read('assets.deleteCheck',{id:aid},true);if(assetCheck.blocked||assetCheck.deleteBillIds.length||assetCheck.retainedBillIds.length)throw new DomainError('ACCEPTANCE_DELETE_BLOCKED','仅删除没有任何账单关系的测试空资产');await e.write('empty-asset-delete','assets.delete',{id:aid,expectedVersion:assetCheck.expectedVersion});e.invalidateSource(assetListKey());if((await e.read('assets.list',{status:0,includeInstallments:true,limit:200},true)).items.some(asset=>asset.id===aid))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','空资产删除未得到官方目录证明');
 return {state:'ready',bookRenameMonthRangeVisibilityEmptyDeleteAndEmptyAssetDelete:true};
}
export async function runCategoryManagement(e:CaseEnvironment){
 const bookId=e.known('book'),query={bookId,type:0 as const},childId=e.known('category-child'),get=async()=>{e.invalidateSource(categoryKey(query));return (await e.read('categories.list',query)).items;};
 let rows=await get(),child=rows.find(row=>row.id===childId)!;
 await e.write('category-promote','categories.changeLevel',{...query,id:childId,expectedVersion:child.editVersion,parentId:null});rows=await get();child=rows.find(row=>row.id===childId)!;if(child.level!==1)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类升级未回拉');
 await e.write('category-demote','categories.changeLevel',{...query,id:childId,expectedVersion:child.editVersion,parentId:e.known('category-parent')});rows=await get();child=rows.find(row=>row.id===childId)!;if(child.parentId!==e.known('category-parent'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类降级未回拉');
 await e.write('category-move','categories.move',{...query,id:childId,expectedVersion:child.editVersion,parentId:e.known('batch-category-a')});rows=await get();if(rows.find(row=>row.id===childId)?.parentId!==e.known('batch-category-a'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类移动未回拉');
 for(const row of rows)if(row.bookId===bookId)e.remember('sort-category-'+row.id,'category',row.id);
 const groups=[{parentId:null,ids:rows.filter(row=>row.level===1).map(row=>row.id).reverse()},...rows.filter(row=>row.level===1&&row.childIds.length).map(row=>({parentId:row.id,ids:[...row.childIds].reverse()}))];await e.write('category-reorder','categories.reorder',{...query,groups});
 if(!e.optional('empty-category'))e.remember('empty-category','category',oneId(await e.write('empty-category-create','categories.submit',{mode:'create',...query,name:e.prefix+'空分类删除',parentId:null})));
 const check=await e.read('categories.checkDelete',{...query,id:e.known('empty-category')});if(check.blocked||check.count||check.other)throw new DomainError('ACCEPTANCE_DELETE_BLOCKED','仅删除没有关联账单的测试空分类');await e.write('empty-category-delete','categories.delete',{...query,id:check.id,expectedVersion:check.expectedVersion,deleteBills:false});if((await get()).some(row=>row.id===check.id))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','空分类删除未回拉');
 return {state:'ready',promoteDemoteMoveOrderAndEmptyDelete:true};
}
export async function runTagManagement(e:CaseEnvironment){
 if(!e.optional('delete-tag-group'))e.remember('delete-tag-group','tagGroup',oneId(await e.write('delete-tag-group-create','tags.submitGroup',{mode:'create',name:e.prefix+'删组'})));
 const groupId=e.known('delete-tag-group');for(const label of ['a','b'])if(!e.optional('delete-tag-'+label))e.remember('delete-tag-'+label,'tag',oneId(await e.write('delete-tag-create-'+label,'tags.submitTag',{mode:'create',name:e.prefix+'删除标签'+label,groupId,color:'E8AE51'})));
 await e.write('delete-tags-reorder','tags.reorderTags',{ids:[e.known('delete-tag-b'),e.known('delete-tag-a')]});
 for(const label of ['a','b']){e.invalidateSource(tagCatalogKey);const tag=(await e.read('tags.list',{includeArchived:true})).items.find(tag=>tag.id===e.known('delete-tag-'+label));if(!tag)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试标签缺失');await e.write('delete-tag-'+label,'tags.deleteTag',{id:tag.id,expectedVersion:tag.editVersion});}
 e.invalidateSource(tagCatalogKey);const group=(await e.read('tags.list',{includeArchived:true})).groups.find(group=>group.id===groupId);if(!group)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试标签组缺失');await e.write('delete-tag-group','tags.deleteGroup',{id:groupId,expectedVersion:group.editVersion});e.invalidateSource(tagCatalogKey);const result=await e.read('tags.list',{includeArchived:true});if(result.groups.some(group=>group.id===groupId)||result.items.some(tag=>['a','b'].some(label=>tag.id===e.known('delete-tag-'+label))))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','测试标签/分组删除未回拉');
 return {state:'ready',tagOrderEmptyDeletesAndGroupDelete:true};
}
