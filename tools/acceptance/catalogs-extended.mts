import {DomainError} from '../../src/shared/errors';
import {tagCatalogKey} from '../../src/features/tags/source';
import {categoryKey} from '../../src/features/categories/source';
import {assetGroupKey} from '../../src/features/assets/groups';
import {assetInfoKey} from '../../src/features/assets/service';
import type {CaseEnvironment} from './cases.mts';
const check=(ok:unknown,message:string)=>{if(!ok)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH',message);};
const one=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);check(ids.length===1,'新增缺少唯一官方ID');return ids[0]!;};
export async function runTagsExtended(e:CaseEnvironment){
 const get=async()=>{e.invalidateSource(tagCatalogKey);return e.read('tags.list',{includeArchived:true});};
 await e.phase('tags-ext-metadata',async()=>{
  e.remember('ext-group','tagGroup',one(await e.write('ext-group-create','tags.submitGroup',{mode:'create',name:e.prefix+'补'})));
  e.remember('ext-tag','tag',one(await e.write('ext-tag-create','tags.submitTag',{mode:'create',name:e.prefix+'补充标签',groupId:e.known('ext-group'),color:'123456'})));
  let list=await get(),group=list.groups.find(row=>row.id===e.known('ext-group'))!;
  await e.write('ext-group-edit','tags.submitGroup',{mode:'edit',id:group.id,expectedVersion:group.editVersion,name:e.prefix+'改'});
  list=await get();let tag=list.items.find(row=>row.id===e.known('ext-tag'))!;
  await e.write('ext-tag-edit','tags.submitTag',{mode:'edit',id:tag.id,expectedVersion:tag.editVersion,name:e.prefix+'标签改名',groupId:e.known('ext-group'),color:'ABCDEF'});
  list=await get();tag=list.items.find(row=>row.id===tag.id)!;check(tag.name===e.prefix+'标签改名'&&tag.color?.toUpperCase()==='ABCDEF','标签名称/颜色编辑未回拉');check(list.groups.find(row=>row.id===group.id)?.name===e.prefix+'改','标签组改名未回拉');
 });
 await e.phase('tags-ext-delete-group',async()=>{
  const list=await get(),group=list.groups.find(row=>row.id===e.known('ext-group'))!;
  await e.write('ext-nonempty-group-delete','tags.deleteGroup',{id:group.id,expectedVersion:group.editVersion});
  const after=await get(),tag=after.items.find(row=>row.id===e.known('ext-tag'));check(!after.groups.some(row=>row.id===group.id)&&tag&&tag.groupId===null,'删除非空分组应保留并解除标签分组');
 });
 await e.phase('tags-ext-ungrouped',async()=>{
  e.remember('ext-ungrouped-tag','tag',one(await e.write('ext-ungrouped-tag-create','tags.submitTag',{mode:'create',name:e.prefix+'无组标签',groupId:null,color:'123456'})));
  const list=await get();check(list.items.find(row=>row.id===e.known('ext-ungrouped-tag'))?.groupId===null,'无分组标签未回拉');
 });
 await e.phase('tags-ext-cleanup',async()=>{for(const alias of ['ext-tag','ext-ungrouped-tag']){const tag=(await get()).items.find(row=>row.id===e.known(alias))!;await e.write(alias+'-delete','tags.deleteTag',{id:tag.id,expectedVersion:tag.editVersion});}const list=await get();check(!list.items.some(row=>[e.known('ext-tag'),e.known('ext-ungrouped-tag')].includes(row.id)),'测试标签清理未回拉');});
 return {state:'ready',tagAndGroupEditUngroupedAndNonemptyGroupDeletion:true};
}
export async function runCatalogsExtended(e:CaseEnvironment){
 const bookId=e.known('book'),query={bookId,type:1 as const},get=async()=>{e.invalidateSource(categoryKey(query));return e.read('categories.list',query);};
 await e.phase('income-category-ext',async()=>{
  e.remember('ext-income-parent','category',one(await e.write('ext-income-parent','categories.submit',{mode:'create',...query,name:e.prefix+'收入父',parentId:null})));
  e.remember('ext-income-child','category',one(await e.write('ext-income-child','categories.submit',{mode:'create',...query,name:e.prefix+'收入子',parentId:e.known('ext-income-parent')})));
  let child=(await get()).items.find(row=>row.id===e.known('ext-income-child'))!;await e.write('ext-income-edit','categories.submit',{mode:'edit',...query,id:child.id,expectedVersion:child.editVersion,name:e.prefix+'收入子改'});
  child=(await get()).items.find(row=>row.id===child.id)!;check(child.name===e.prefix+'收入子改','收入分类编辑未回拉');
  await e.write('ext-income-promote','categories.changeLevel',{...query,id:child.id,expectedVersion:child.editVersion,parentId:null});child=(await get()).items.find(row=>row.id===child.id)!;check(child.level===1,'收入分类升级未回拉');
  await e.write('ext-income-demote','categories.changeLevel',{...query,id:child.id,expectedVersion:child.editVersion,parentId:e.known('ext-income-parent')});child=(await get()).items.find(row=>row.id===child.id)!;check(child.level===2,'收入分类降级未回拉');
  const icons=await e.read('categories.icons',{}),icon=icons.items[0]?.icon;check(icon,'官方图标未返回');
  const result=await e.write('ext-income-batch','categories.submitMany',{...query,parentId:e.known('ext-income-parent'),items:[{name:e.prefix+'收入批甲',icon},{name:e.prefix+'收入批乙',icon}]});let i=0;for(const id of Object.values(result.idMap))e.remember('ext-income-batch-'+i++,'category',id);check(i===2,'收入二级批量分类回执不完整');
  const list=(await get()).items;check(list.filter(row=>Object.values(result.idMap).includes(row.id)).every(row=>row.level===2&&row.parentId===e.known('ext-income-parent')),'收入二级批量层级未回拉');
 });
 await e.phase('asset-group-ext',async()=>{
  e.remember('ext-asset-group','assetGroup',one(await e.write('ext-asset-group-create','assets.groups.submit',{id:null,name:e.prefix+'资产补充分组'})));
  e.invalidateSource(assetGroupKey);let group=(await e.read('assets.groups.list',{},true)).items.find(row=>row.id===e.known('ext-asset-group'))!;
  await e.write('ext-asset-group-edit','assets.groups.submit',{id:group.id,expectedVersion:group.editVersion,name:e.prefix+'资产分组改名'});e.invalidateSource(assetGroupKey);group=(await e.read('assets.groups.list',{},true)).items.find(row=>row.id===group.id)!;check(group.name===e.prefix+'资产分组改名','资产分组编辑未回拉');
  await e.write('ext-asset-group-add','assets.groups.add',{groupId:group.id,assetIds:[e.known('cash-b')]});
  e.invalidateSource(assetGroupKey);group=(await e.read('assets.groups.list',{},true)).items.find(row=>row.id===group.id)!;await e.write('ext-nonempty-asset-group-delete','assets.groups.delete',{id:group.id,expectedVersion:group.editVersion});
  e.invalidateSource(assetInfoKey(e.known('cash-b')));const detail=await e.read('assets.detail',{id:e.known('cash-b')},true);check(detail.asset&&detail.asset.groupId!==group.id,'删除资产组后资产仍引用旧分组');
 });
 return {state:'ready',incomeCategoryEditLevelBatchAndAssetGroupEditNonemptyDelete:true};
}
