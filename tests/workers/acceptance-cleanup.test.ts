import {expect,it} from 'vitest';
import {assertCleanupTarget,assertOrphanSavingProvenance} from '../../tools/acceptance/cleanup-guard.mts';
import type {AcceptanceManifest} from '../../tools/acceptance/scope.mts';
import {AcceptanceScope} from '../../tools/acceptance/scope.mts';
import {cleanupWriteStep} from '../../tools/acceptance/cleanup-guard.mts';
import {guardReferences} from '../../tools/acceptance/cleanup.mts';
import {createTestApp} from '../support/app';
const manifest:AcceptanceManifest={uid:'test-user',prefix:'dedicated-test-',actions:['books.delete'],resources:{book:['new-book'],asset:['new-asset']}};
it('allows a registered newly created resource with only dedicated book references',()=>{
 expect(()=>assertCleanupTarget(manifest,'test-user','asset','new-asset',['new-book'])).not.toThrow();
});
it('never authorizes deletion by a matching name or prefix',()=>{
 expect(()=>assertCleanupTarget(manifest,'test-user','book','dedicated-test-unregistered',[])).toThrow('清单');
});
it('blocks deletion with any personal book reference even for a registered asset',()=>{
 expect(()=>assertCleanupTarget(manifest,'test-user','asset','new-asset',['new-book','personal-book'])).toThrow('关联');
});
it('blocks a different connected account before any deletion',()=>{
 expect(()=>assertCleanupTarget(manifest,'other-user','book','new-book',[])).toThrow('账号');
});
const proof={uid:'test-user',sendCount:1,payload:{creating:true,kind:'submit',before:null,beforeIds:[],params:{name:'dedicated-test-saving',currency:'CNY',mode:'custom',rule:{mode:'custom',total:'10',start:'1000',end:'0'},remark:'dedicated-test-progress',color:'3792FA',icon:''}}};
const orphan={planid:'new-plan',userid:'test-user',name:'dedicated-test-saving',currency:'CNY',mode:'custom',rule:{mode:'custom',total:'10',start:'1000'},remark:'dedicated-test-progress',color:'3792FA',icon:'http://res3.qianjiapp.com/cate_phone.png',transactions:[]};
it('identifies an orphan test saving using the empty complete pre-send snapshot and full immutable configuration',()=>{
 expect(()=>assertOrphanSavingProvenance(manifest,proof,orphan)).not.toThrow();
});
it('does not adopt a matching plan that existed before the acceptance write',()=>{
 expect(()=>assertOrphanSavingProvenance(manifest,{...proof,payload:{...proof.payload,beforeIds:['new-plan']}},orphan)).toThrow();
});
it('does not adopt a same-name plan with a different amount or existing deposits',()=>{
 expect(()=>assertOrphanSavingProvenance(manifest,proof,{...orphan,rule:{...orphan.rule,total:'11'}})).toThrow();
 expect(()=>assertOrphanSavingProvenance(manifest,proof,{...orphan,transactions:[{transid:'unproven'}]})).toThrow();
});
it('rejects any cleanup saving deletion that could cascade into newly linked personal bills',()=>{
 const scope=new AcceptanceScope({...manifest,actions:['savings.delete'],resources:{...manifest.resources,saving:['new-plan']}});
 expect(()=>scope.authorize('test-user','savings.delete',{requestId:'dedicated-test-:cleanup-saving-new-plan',planId:'new-plan',deleteBills:true})).toThrow();
 expect(()=>scope.authorize('test-user','savings.delete',{requestId:'dedicated-test-:cleanup-saving-new-plan',planId:'new-plan',deleteBills:false})).not.toThrow();
});
it('permits one new cleanup intent only after a conclusively unsent version failure',()=>{
 expect(cleanupWriteStep('cleanup-repeat-1',{state:'failed',sendCount:0,error:{code:'DRAFT_SOURCE_CHANGED'}})).toBe('cleanup-repeat-1-version-refresh');
 expect(cleanupWriteStep('cleanup-repeat-1',{state:'uncertain',sendCount:1,error:{code:'DRAFT_SOURCE_CHANGED'}})).toBe('cleanup-repeat-1');
 expect(cleanupWriteStep('cleanup-repeat-1',{state:'failed',sendCount:1,error:{code:'DRAFT_SOURCE_CHANGED'}})).toBe('cleanup-repeat-1');
 expect(cleanupWriteStep('cleanup-repeat-1-version-refresh',{state:'failed',sendCount:0,error:{code:'DRAFT_SOURCE_CHANGED'}})).toBe('cleanup-repeat-1-version-refresh');
});
it('checks book and asset catalogs that legitimately have no plan data field',async()=>{
 const app=await createTestApp({uid:manifest.uid,connectionEpoch:'cleanup-epoch'});
 await app.repository(repository=>{
  repository.createDataset(app.scope,'ledger','cleanup-ledger');
  repository.sql.exec("UPDATE datasets SET complete=1 WHERE uid=? AND id='cleanup-ledger'",manifest.uid).toArray();
  repository.sql.exec("INSERT INTO active_datasets(uid,domain,dataset_id) VALUES (?,'ledger','cleanup-ledger')",manifest.uid).toArray();
  expect(()=>guardReferences({repository},app.scope,manifest,[{kind:'book',id:'new-book',raw:{bookid:'new-book',name:'test'}},{kind:'asset',id:'new-asset',raw:{id:'new-asset',name:'test'}}])).not.toThrow();
 });
});
