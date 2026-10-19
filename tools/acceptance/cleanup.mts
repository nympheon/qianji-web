import type {createActorContext} from '../../src/actor/context';
import type {ActorScope} from '../../src/shared/model';
import {asBillObject,billExtra,numericText,type BillObject} from '../../src/shared/bill-wire';
import {DomainError} from '../../src/shared/errors';
import {refreshBooks} from '../../src/features/books/source';
import {refreshRepeats,repeatView} from '../../src/features/repeat/source';
import {refreshInstallments,installmentView} from '../../src/features/installments/source';
import {refreshSavings,savingsView} from '../../src/features/savings/source';
import {refreshTags} from '../../src/features/tags/source';
import {loadGroupRecords} from '../../src/features/assets/groups';
import {validateAsset} from '../../src/features/assets/model';
import {billVersion} from '../../src/features/ledger/write';
import type {AcceptanceManifest,TestResource} from './scope.mts';
import {assertCleanupTarget} from './cleanup-guard.mts';
import {tagView,tagGroupView} from '../../src/features/tags/source';
import type {CaseEnvironment} from './cases.mts';
import {parseWire} from '../../src/shared/wire-json';
type Context=ReturnType<typeof createActorContext>;
export interface CleanupNode {kind:TestResource;id:string;raw:BillObject}
/** Complete official catalogs, never a local absence or a prefix search. No writes. */
export async function cleanupSnapshot(ctx:Context,scope:ActorScope):Promise<CleanupNode[]>{
 const nodes:CleanupNode[]=[];
 for(const item of await refreshBooks(ctx,scope))nodes.push({kind:'book',id:item.id,raw:item.raw});
 const assets=new Map<string,BillObject>();
 for(const status of [0,2]){
  const reply=await ctx.client.request('asset.list',{uid:scope.uid,status},scope),data=asBillObject(reply.data);
  if(reply.hasMore||!Array.isArray(data.list)||data.list.length>5000)throw new DomainError('CLEANUP_SOURCE_INCOMPLETE','资产完整列表无法核对');
  for(const value of data.list){const raw=validateAsset(asBillObject(value),scope);assets.set(numericText(raw.id,''),raw);}
 }
 for(const t of [51,52])for(const status of [0,1]){
  const reply=await ctx.client.request('asset.loans',{uid:scope.uid,t,status},scope);
  if(reply.hasMore||!Array.isArray(reply.data)||reply.data.length>5000)throw new DomainError('CLEANUP_SOURCE_INCOMPLETE','借贷完整列表无法核对');
  for(const value of reply.data){const raw=validateAsset(asBillObject(value),scope);assets.set(numericText(raw.id,''),raw);}
 }
 for(const [id,raw] of assets)nodes.push({kind:'asset',id,raw});
 for(const item of await loadGroupRecords(ctx.client,scope))nodes.push({kind:'assetGroup',id:item.id,raw:asBillObject(item.raw)});
 for(const raw of await refreshRepeats(ctx,scope))nodes.push({kind:'repeat',id:numericText(raw.id,''),raw});
 for(const raw of await refreshInstallments(ctx,scope))nodes.push({kind:'installment',id:numericText(raw.id,''),raw});
 for(const raw of await refreshSavings(ctx,scope))nodes.push({kind:'saving',id:savingsView(raw).planId,raw});
 for(const item of await refreshTags(ctx,scope))nodes.push({kind:item.kind as 'tag'|'tagGroup',id:item.id,raw:asBillObject(item.raw)});
 return nodes;
}
export function cleanupInventory(manifest:AcceptanceManifest,nodes:CleanupNode[]){
 const owned=nodes.filter(node=>manifest.resources[node.kind]?.includes(node.id));
 const unregistered=nodes.filter(node=>!manifest.resources[node.kind]?.includes(node.id)&&String(node.raw.name??asBillObject(node.raw.data).remark??'').startsWith(manifest.prefix));
 const summary=(node:CleanupNode)=>({kind:node.kind,id:node.id,name:String(node.raw.name??asBillObject(node.raw.data).remark??''),version:billVersion(node.raw)});
 const personal=nodes.filter(node=>!manifest.resources[node.kind]?.includes(node.id)&&!unregistered.includes(node));
 return {owned:owned.map(summary),unregistered:unregistered.map(summary),personalCount:personal.length,personalIdentityHash:billVersion(personal.map(node=>({kind:node.kind,id:node.id})).sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id)))};
}
export function guardReferences(ctx:Pick<Context,'repository'>,scope:ActorScope,manifest:AcceptanceManifest,nodes:CleanupNode[]){
 const dataset=ctx.repository.dataset(scope,'ledger');if(!dataset?.complete)throw new DomainError('CLEANUP_SOURCE_INCOMPLETE','清理前必须完成账单同步');
 const rows=ctx.repository.sql.exec<{id:string;book_id:string;raw:string}>("SELECT id,book_id,raw FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND status_code<>0 LIMIT 50001",scope.uid,dataset.id).toArray();
 if(rows.length>50000)throw new DomainError('CLEANUP_SOURCE_INCOMPLETE','关联影响超过本次核对范围');
 for(const row of rows){
  const raw=asBillObject(parseWire(row.raw)),extra=billExtra(raw);
  if(manifest.resources.book?.includes(row.book_id)){
   if(['assetid','fromid','targetid'].some(key=>{const id=numericText(raw[key],'');return /^[1-9]\d*$/.test(id)&&!manifest.resources.asset?.includes(id);}))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','测试账本关联到非测试资产，停止全部清理');
   continue;
  }
  if(['assetid','fromid','targetid'].some(key=>manifest.resources.asset?.includes(numericText(raw[key],'')))||Array.isArray(extra.tags)&&extra.tags.some(id=>typeof id==='string'&&manifest.resources.tag?.includes(id)))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','测试资产或标签关联到非测试账本，停止全部清理');
 }
 for(const node of nodes){
  const owned=manifest.resources[node.kind]?.includes(node.id),data=node.kind==='repeat'||node.kind==='installment'?asBillObject(node.raw.data):{};
  if(!owned&&(node.kind==='repeat'||node.kind==='installment')&&[data.bookid,node.raw.assetid,data.fromid,data.targetid].some(id=>manifest.resources.book?.includes(numericText(id,''))||manifest.resources.asset?.includes(numericText(id,''))))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','其他计划引用测试资源，停止全部清理');
  if(owned&&node.kind==='saving')for(const tx of savingsView(node.raw).transactions)if(tx.billId){const bill=ctx.repository.readBill(scope,tx.billId);if(!bill)throw new DomainError('CLEANUP_SOURCE_INCOMPLETE','存钱关联账单不完整');assertCleanupTarget(manifest,scope.uid,'saving',node.id,[bill.bookId]);}
  if(!owned&&node.kind==='saving'&&savingsView(node.raw).transactions.some(tx=>tx.billId&&manifest.resources.book?.includes(ctx.repository.readBill(scope,tx.billId)?.bookId??'')))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','非测试存钱计划关联到测试账本');
  if(owned&&node.kind==='tagGroup'&&Array.isArray(node.raw.tags)&&node.raw.tags.some(value=>!manifest.resources.tag?.includes(String(asBillObject(value).id))))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','测试标签组含有非测试标签');
  if(!owned&&node.kind==='asset'&&manifest.resources.assetGroup?.includes(numericText(node.raw.groupid,'')))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','测试资产组含有非测试资产');
 }
 return rows.filter(row=>manifest.resources.book?.includes(row.book_id)).length;
}
/** Finite, local-only cleanup. Every mutation uses the original bounded acceptance policy. */
export async function runCleanup(ctx:Context,scope:ActorScope,manifest:AcceptanceManifest,e:CaseEnvironment,verifyOnly=false){
 await e.synchronize();
 const nodes=await cleanupSnapshot(ctx,scope),before=cleanupInventory(manifest,nodes);
 if(before.unregistered.length)throw new DomainError('CLEANUP_ID_UNPROVEN','仍有未证明来源的同名前缀对象，停止清理');
 const testBillCount=guardReferences(ctx,scope,manifest,nodes);
 const baseline=e.checkpoint('cleanup:baseline',{personalIdentityHash:before.personalIdentityHash,personalCount:before.personalCount,testBillCount,owned:before.owned.map(({kind,id})=>({kind,id}))});
 if(before.personalIdentityHash!==baseline.personalIdentityHash)throw new DomainError('CLEANUP_PERSONAL_CHANGED','非测试资源清单已变化，需重新核对');
 if(!verifyOnly){
  const owned=(kind:TestResource)=>nodes.filter(node=>node.kind===kind&&manifest.resources[kind]?.includes(node.id));
  const remove=async(node:CleanupNode)=>{
   assertCleanupTarget(manifest,scope.uid,node.kind,node.id,[]);
   const step=`cleanup-${node.kind}-${node.id}`;
   if(node.kind==='saving')await e.write(step,'savings.delete',{planId:node.id,deleteBills:false});
   else if(node.kind==='repeat'){const fresh=(await refreshRepeats(ctx,scope)).find(raw=>numericText(raw.id,'')===node.id);if(fresh)await e.write(step,'repeat.delete',{id:node.id,expectedVersion:repeatView(fresh).editVersion});}
   else if(node.kind==='installment'){const fresh=(await refreshInstallments(ctx,scope)).find(raw=>numericText(raw.id,'')===node.id);if(fresh)await e.write(step,'installments.delete',{id:node.id,expectedVersion:installmentView(fresh).editVersion});}
   else if(node.kind==='book'){const fresh=(await refreshBooks(ctx,scope)).find(item=>item.id===node.id);if(fresh)await e.write(step,'books.delete',{id:node.id,expectedVersion:billVersion(fresh.raw)});}
   else if(node.kind==='asset'){
    const actual=await ctx.assets.refreshInfo(node.id),check=await ctx.assets.checkDelete(node.id);
    const books=[...check.deleteBillIds,...check.retainedBillIds].map(id=>ctx.repository.readBill(scope,id)?.bookId??'unknown');assertCleanupTarget(manifest,scope.uid,'asset',node.id,books);
    await e.write(step,'assets.delete',{id:node.id,expectedVersion:actual.editVersion});
   }else if(node.kind==='tag'||node.kind==='tagGroup'){const fresh=(await refreshTags(ctx,scope)).find(item=>item.id===node.id&&item.kind===node.kind);if(fresh)await e.write(step,node.kind==='tag'?'tags.deleteTag':'tags.deleteGroup',{id:node.id,expectedVersion:node.kind==='tag'?tagView(asBillObject(fresh.raw)).editVersion:tagGroupView(asBillObject(fresh.raw)).editVersion});}
   else if(node.kind==='assetGroup'){e.invalidateSource({domain:'assets',queryKey:'asset:groups',resourceKind:'assetGroup'});const fresh=(await e.read('assets.groups.list',{},true)).items.find(item=>item.id===node.id);if(fresh)await e.write(step,'assets.groups.delete',{id:node.id,expectedVersion:fresh.editVersion});}
  };
  for(const kind of ['repeat','installment','saving'] as const)for(const node of owned(kind))await remove(node);
  for(const node of owned('asset').filter(node=>numericText(node.raw.type,'')==='5'))await remove(node);
  for(const node of owned('book'))await remove(node);
  await e.synchronize();
  for(const node of owned('asset').filter(node=>numericText(node.raw.type,'')!=='5'))await remove(node);
  for(const kind of ['tag','tagGroup','assetGroup'] as const)for(const node of owned(kind))await remove(node);
 }
 await e.synchronize();
 const after=cleanupInventory(manifest,await cleanupSnapshot(ctx,scope));
 if(after.personalIdentityHash!==baseline.personalIdentityHash)throw new DomainError('CLEANUP_PERSONAL_CHANGED','非测试资源清单变化，停止并保留记录');
 if(after.owned.length||after.unregistered.length)throw new DomainError('CLEANUP_REMAINS','官方完整目录仍存在测试资源');
 const dataset=ctx.repository.dataset(scope,'ledger')!,books=manifest.resources.book??[];
 const remaining=books.length?ctx.repository.sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND status_code<>0 AND book_id IN (${books.map(()=>'?').join(',')})`,scope.uid,dataset.id,...books).one().n:0;
 if(remaining)throw new DomainError('CLEANUP_REMAINS','同步后仍有测试账单');
 return {state:'ready',officialAbsenceVerified:true,testBillsRemaining:remaining,baseline,after,oldUnknownOperationsRetained:true};
}
