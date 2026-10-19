import {DomainError} from '../../src/shared/errors';
import {compareMoney,addMoney} from '../../src/shared/numbers';
import {assetInfoKey} from '../../src/features/assets/service';
import {tagCatalogKey} from '../../src/features/tags/source';
import {bookListKey} from '../../src/features/books/source';
import {createdBill} from './ledger.mts';
import type {CaseEnvironment} from './cases.mts';
const check=(ok:unknown,message:string)=>{if(!ok)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH',message);};
const one=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);check(ids.length===1,'新建缺少唯一官方ID');return ids[0]!;};
async function bill(e:CaseEnvironment,alias:string,categoryId:string,assetId:string,money:string,tagIds:string[]=[],bookId=e.known('book')){
 if(!e.optional(alias))e.remember(alias,'bill',createdBill(await e.write(alias,'ledger.create',{bills:[{bookId,type:0,categoryId,assetId,enteredMoney:money,fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+alias,tagIds}]})));
 await e.synchronize();return e.read('ledger.detail',{id:e.known(alias)});
}
async function balance(e:CaseEnvironment,id:string){e.invalidateSource(assetInfoKey(id));const result=await e.read('assets.detail',{id},true);check(result.asset,'测试资产缺失');return result.asset!.money;}
async function absent(e:CaseEnvironment,id:string){try{await e.read('ledger.detail',{id});throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','被删除测试账单仍在官方来源中');}catch(error){if(!(error instanceof DomainError)||error.code!=='BILL_NOT_FOUND')throw error;}}
export async function inspectLinked(e:CaseEnvironment){await e.synchronize();const id=e.known('cash-a'),current=await balance(e,id),before=e.checkpoint('linked-category-balance',current);return {state:'ready',originalBalance:before,currentBalance:current,categoryDeletedBillAbsent:await absent(e,e.known('linked-remove-bill')).then(()=>true),deletedBookBillAbsent:await absent(e,e.known('linked-cross-bill')).then(()=>true)};}
export async function inspectLinkedAssets(e:CaseEnvironment){await e.synchronize();const items=[];for(const alias of ['linked-asset-expense','linked-asset-transfer'])try{const bill=await e.read('ledger.detail',{id:e.known(alias)},true);items.push({alias,id:bill.id,type:bill.type,money:bill.money,assetId:bill.assetId,fromId:bill.fromId,targetId:bill.targetId});}catch(error){if(!(error instanceof DomainError)||!['BILL_NOT_FOUND','BILL_NOT_LOADED'].includes(error.code))throw error;items.push({alias,queryProblem:error.code});}return {state:'ready',originalCounterpartyBalance:e.checkpoint('linked-asset-balance','unknown'),currentCounterpartyBalance:await balance(e,e.known('cash-b')),items};}
export async function runDeleteBalance(e:CaseEnvironment){
 await e.synchronize();const cashId=e.known('cash-a'),query={bookId:e.known('book'),type:0 as const};
 await e.phase('delete-balance-category',async()=>{
  if(!e.optional('balance-delete-category'))e.remember('balance-delete-category','category',one(await e.write('balance-delete-category','categories.submit',{mode:'create',...query,name:e.prefix+'余额验证分类',parentId:null})));
  await bill(e,'balance-delete-category-bill',e.known('balance-delete-category'),cashId,'0.01');const prior=e.checkpoint('category-delete-native-balance',await balance(e,cashId));
  if(e.hasIntent('balance-delete-category-with-bill'))await e.write('balance-delete-category-with-bill','categories.delete',{});else{const checkResult=await e.read('categories.checkDelete',{...query,id:e.known('balance-delete-category')});await e.write('balance-delete-category-with-bill','categories.delete',{...query,id:checkResult.id,expectedVersion:checkResult.expectedVersion,deleteBills:true});}
  await e.synchronize();await absent(e,e.known('balance-delete-category-bill'));check(compareMoney(await balance(e,cashId),prior)===0,'原生分类批量删除的余额保持行为发生变化');
 });
 await e.phase('delete-balance-book',async()=>{
  if(!e.optional('balance-delete-book'))e.remember('balance-delete-book','book',one(await e.write('balance-delete-book','books.submit',{mode:'create',name:e.prefix+'余额验证账本',type:-1})));
  if(!e.optional('balance-delete-book-category'))e.remember('balance-delete-book-category','category',one(await e.write('balance-delete-book-category','categories.submit',{mode:'create',bookId:e.known('balance-delete-book'),type:0,name:e.prefix+'余额验证目标',parentId:null})));
  await bill(e,'balance-delete-book-bill',e.known('balance-delete-book-category'),cashId,'0.02',[],e.known('balance-delete-book'));const prior=e.checkpoint('book-delete-native-balance',await balance(e,cashId));
  if(e.hasIntent('balance-delete-book-with-bill'))await e.write('balance-delete-book-with-bill','books.delete',{});else{const checkResult=await e.read('books.deleteCheck',{id:e.known('balance-delete-book')});check(!checkResult.blocked,'新的余额验证账本仍有未结事项');await e.write('balance-delete-book-with-bill','books.delete',{id:checkResult.id,expectedVersion:checkResult.expectedVersion});}
  await e.synchronize();await absent(e,e.known('balance-delete-book-bill'));check(compareMoney(await balance(e,cashId),prior)===0,'原生账本删除的余额保持行为发生变化');
 });return {state:'ready',categoryAndBookBatchDeletesPreserveOfficialAssetBalance:true};
}
export async function runLinkedCategories(e:CaseEnvironment){
 await e.synchronize();const cashId=e.known('cash-a'),before=e.checkpoint('linked-category-balance',await balance(e,cashId)),query={bookId:e.known('book'),type:0 as const};
 await e.phase('linked-categories-setup',async()=>{
  for(const label of ['from','to','remove','cross'])e.remember('linked-cate-'+label,'category',one(await e.write('linked-cate-'+label,'categories.submit',{mode:'create',...query,name:e.prefix+'关联分类'+label,parentId:null})));
  e.remember('linked-target-book','book',one(await e.write('linked-target-book','books.submit',{mode:'create',name:e.prefix+'迁移目标账本',type:-1})));
  e.remember('linked-target-category','category',one(await e.write('linked-target-category','categories.submit',{mode:'create',bookId:e.known('linked-target-book'),type:0,name:e.prefix+'目标分类',parentId:null})));
 });
 await e.phase('linked-category-same-book',async()=>{
  const source=await bill(e,'linked-cate-bill',e.known('linked-cate-from'),cashId,'0.11');const impact=await e.read('categories.checkDelete',{...query,id:source.categoryId!});check(!impact.blocked&&impact.count===1,'同账本迁移删除影响不符');
  await e.write('linked-cate-migrate','categories.delete',{...query,id:impact.id,expectedVersion:impact.expectedVersion,deleteBills:false,newCategoryId:e.known('linked-cate-to')});await e.synchronize();const after=await e.read('ledger.detail',{id:source.id});check(after.categoryId===e.known('linked-cate-to')&&after.bookId===query.bookId,'同账本分类迁移未回拉');
 });
 await e.phase('linked-category-cross-book',async()=>{
  const source=await bill(e,'linked-cross-bill',e.known('linked-cate-cross'),cashId,'0.12');const impact=e.hasIntent('linked-cross-migrate')?{id:e.known('linked-cate-cross'),expectedVersion:'0'.repeat(64)}:await e.read('categories.checkDelete',{...query,id:source.categoryId!});if('count' in impact)check(!impact.blocked&&impact.count===1,'跨账本迁移删除影响不符');
  const result=await e.write('linked-cross-migrate','categories.delete',{...query,id:impact.id,expectedVersion:impact.expectedVersion,deleteBills:false,newCategoryId:e.known('linked-target-category'),newBookId:e.known('linked-target-book')},['CATEGORY_NOT_DELETED']);await e.synchronize();const after=await e.read('ledger.detail',{id:source.id});check(after.categoryId===e.known('linked-target-category')&&after.bookId===e.known('linked-target-book'),'跨账本分类迁移未回拉');check(result.state==='succeeded'||result.items.some(item=>item.state==='failed'&&item.error?.code==='CATEGORY_NOT_DELETED'),'跨账本迁移未保留原生分类删除结果');
 });
 await e.phase('linked-category-delete-bills',async()=>{
  const source=await bill(e,'linked-remove-bill',e.known('linked-cate-remove'),cashId,'0.13');const impact=await e.read('categories.checkDelete',{...query,id:source.categoryId!});check(!impact.blocked&&impact.count===1,'分类连账单删除影响不符');await e.write('linked-cate-delete-bills','categories.delete',{...query,id:impact.id,expectedVersion:impact.expectedVersion,deleteBills:true});await e.synchronize();await absent(e,source.id);
 });
 await e.phase('linked-category-cleanup',async()=>{
  if(e.hasIntent('linked-cate-bill-delete'))await e.write('linked-cate-bill-delete','ledger.delete',{});else{const source=await e.read('ledger.detail',{id:e.known('linked-cate-bill')});await e.write('linked-cate-bill-delete','ledger.delete',{bills:[{id:source.id,expectedVersion:source.editVersion}]});}
  const bookId=e.known('linked-target-book');if(e.hasIntent('linked-book-delete-with-bill'))await e.write('linked-book-delete-with-bill','books.delete',{});else{const impact=await e.read('books.deleteCheck',{id:bookId});check(!impact.blocked,'新建迁移目标账本仍有未结事项');await e.write('linked-book-delete-with-bill','books.delete',{id:bookId,expectedVersion:impact.expectedVersion});}await e.synchronize();await absent(e,e.known('linked-cross-bill'));e.invalidateSource(bookListKey);check(!(await e.read('books.list',{includeHidden:true})).items.some(book=>book.id===bookId),'删除测试账本未回拉');
  for(const proof of ['delete-balance-category','delete-balance-book'])await e.phase(proof,async()=>{throw new DomainError('ACCEPTANCE_PREREQUISITE','先单独验证原生批量删除保留资产余额的语义');});
 });
 return {state:'ready',sameBookAndCrossBookMigrationCategoryBillDeletionAndNonemptyBookDeletion:true,assetBalanceRestored:false,batchDeletionBalancePolicy:'preserve-official-balance',initialTestBalance:before};
}
export async function runLinkedTags(e:CaseEnvironment){
 await e.synchronize();const cashId=e.known('cash-a'),before=e.checkpoint('linked-tag-balance',await balance(e,cashId));
 await e.phase('linked-tag-setup',async()=>{e.remember('linked-delete-tag','tag',one(await e.write('linked-tag-create','tags.submitTag',{mode:'create',name:e.prefix+'关联删除标签',groupId:null,color:'123456'})));await bill(e,'linked-tag-bill',e.known('expense-category'),cashId,'0.07',[e.known('linked-delete-tag')]);});
 await e.phase('linked-tag-delete',async()=>{const id=e.known('linked-delete-tag');if(e.hasIntent('linked-tag-delete'))await e.write('linked-tag-delete','tags.deleteTag',{});else{e.invalidateSource(tagCatalogKey);const tag=(await e.read('tags.list',{includeArchived:true})).items.find(row=>row.id===id)!;await e.write('linked-tag-delete','tags.deleteTag',{id:tag.id,expectedVersion:tag.editVersion});}await e.synchronize();const row=await e.read('ledger.detail',{id:e.known('linked-tag-bill')});e.invalidateSource(tagCatalogKey);const catalog=await e.read('tags.list',{includeArchived:true});check(!catalog.items.some(tag=>tag.id===id)&&row.tagIds.includes(id),'原生删除标签应移除目录项并保留历史账单ID');});
 await e.phase('linked-tag-cleanup',async()=>{const row=await e.read('ledger.detail',{id:e.known('linked-tag-bill')});await e.write('linked-tag-bill-delete','ledger.delete',{bills:[{id:row.id,expectedVersion:row.editVersion}]});await e.synchronize();check(compareMoney(await balance(e,cashId),before)===0,'标签删除用例未恢复测试资产余额');});return {state:'ready',linkedTagDeletionRetainsHistoricalIdsAndBillCleanup:true};
}
export async function runLinkedAssets(e:CaseEnvironment){
 await e.synchronize();await e.read('assets.types',{});const cashId=e.known('cash-b'),before=e.checkpoint('linked-asset-balance',await balance(e,cashId));
 await e.phase('linked-asset-setup',async()=>{
  e.remember('linked-delete-asset','asset',one(await e.write('linked-asset-create','assets.submit',{mode:'create',fields:{name:e.prefix+'关联删除资产',type:1,subtype:11,currency:'CNY',money:'0',inCount:false}})));
  await bill(e,'linked-asset-expense',e.known('expense-category'),e.known('linked-delete-asset'),'0.12');
  e.remember('linked-asset-transfer','bill',createdBill(await e.write('linked-asset-transfer','ledger.transfer',{mode:'create',bookId:e.known('book'),fromAssetId:e.known('linked-delete-asset'),targetAssetId:cashId,enteredMoney:'0.05',fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'删除资产转账'})));await e.synchronize();
 });
 await e.phase('linked-asset-delete',async()=>{const id=e.known('linked-delete-asset');if(e.hasIntent('linked-asset-delete'))await e.write('linked-asset-delete','assets.delete',{});else{const impact=await e.read('assets.deleteCheck',{id},true);check(!impact.blocked&&impact.retainedBillIds.includes(e.known('linked-asset-expense'))&&impact.deleteBillIds.includes(e.known('linked-asset-transfer')),'资产删除影响未覆盖测试支出和转账');await e.write('linked-asset-delete','assets.delete',{id,expectedVersion:impact.expectedVersion});}await e.synchronize();await absent(e,e.known('linked-asset-transfer'));const row=await e.read('ledger.detail',{id:e.known('linked-asset-expense')});check(row.assetId===id,'普通支出未保留历史资产ID');check(compareMoney(await balance(e,cashId),addMoney(before,'0.05'))===0,'删除资产关联转账应保留官方对端余额');});
 await e.phase('linked-asset-cleanup',async()=>{const row=await e.read('ledger.detail',{id:e.known('linked-asset-expense')});let step='linked-asset-bill-cleanup';if(e.hasIntent(step)){e.requireNotSentFailure(step,'ASSET_NOT_LOADED');step+='-verified-unsent';}await e.write(step,'ledger.delete',{bills:[{id:row.id,expectedVersion:row.editVersion}]});await e.synchronize();await absent(e,row.id);});return {state:'ready',assetDeletionRetainsOrdinaryReferenceAndDeletesTransfer:true,counterpartyBalanceRestored:false};
}
