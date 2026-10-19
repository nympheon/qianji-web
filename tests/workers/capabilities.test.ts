import { expect,it } from 'vitest';
import { AcceptanceScope } from '../../tools/acceptance/scope.mts';
import { actionDefinitions } from '../../src/contracts/actions';
import {isPublicAction} from '../../src/contracts/scope';
import {vi} from 'vitest';
import { DomainError } from '../../src/shared/errors';
import { createTestApp } from '../support/app';
import { TestClock,createUpstream } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { AppRegistry } from '../../src/app/registry';
import { createActorContext } from '../../src/actor/context';
const manifest={uid:'test-user',prefix:'QJ验收-20261019-',actions:['books.submit','ledger.create','ledger.edit','books.setBaseCurrency'],resources:{book:['100'],asset:['200'],category:['300'],bill:['400']}};
it('allows plan binding only to a separately proven test pack and a registered test bill',()=>{
 const policy={...manifest,actions:['repeat.setBillBinding'],resources:{repeat:['900'],bill:['400'],pack:['901']}},scope=new AcceptanceScope(policy),input={requestId:manifest.prefix+'binding',planId:'900',packId:'901',billId:'400',bound:true};
 expect(()=>scope.authorize('test-user','repeat.setBillBinding',input)).not.toThrow();
 for(const value of [{...input,packId:'personal-pack'},{...input,planId:'personal-plan'},{...input,billId:'personal-bill'}])expect(()=>scope.authorize('test-user','repeat.setBillBinding',value)).toThrow('ACCEPTANCE_SCOPE_DENIED');
});
it('removes excluded account, member and global ordering operations from discovery and every public invocation',async()=>{
 const app=await createTestApp();await app.repository(async(_repository,storage)=>{
  const context=createActorContext(storage),registry=new AppRegistry(context),removed=['books.setBaseCurrency','books.quit','books.members','books.reorder','assets.reorder','assets.groups.reorder','tags.reorderGroups','savings.reorder'];
  const listed=await registry.invoke('capabilities.list',{});expect((listed.data as {action:string}[]).some(row=>removed.includes(row.action))).toBe(false);
  for(const action of removed){expect(await registry.invoke(action,{})).toMatchObject({status:'error',error:{code:'ACTION_NOT_FOUND'}});expect(await new AppRegistry(context,()=>{}).invoke(action,{})).toMatchObject({status:'error',error:{code:'ACTION_NOT_FOUND'}});}
 });
});
it('enables every provided production write together after acceptance',()=>{
 for(const [name,definition] of Object.entries(actionDefinitions))if(isPublicAction(name)&&definition.kind==='write'){expect(definition.evidence,name).toBe('live-verified');expect(definition.unavailable,name).toBeUndefined();}
});
it('permits only a named test book bootstrap and explicit test references',()=>{
  const scope=new AcceptanceScope(manifest);expect(()=>scope.authorize('test-user','books.submit',{mode:'create',name:manifest.prefix+'账本',type:0,requestId:manifest.prefix+'book'})).not.toThrow();
  expect(()=>scope.authorize('test-user','ledger.create',{requestId:manifest.prefix+'bill',bills:[{bookId:'100',categoryId:'300',assetId:'200',enteredMoney:'1',remark:manifest.prefix+'支出'}]})).not.toThrow();
});
it('rejects cross-user, personal targets, mixed batches and global currency changes',()=>{
  const scope=new AcceptanceScope(manifest),input={requestId:manifest.prefix+'edit',bills:[{id:'400',changes:{remark:'ok'}}]};
  for(const [uid,action,value] of [
    ['other-user','ledger.edit',input],
    ['test-user','ledger.edit',{...input,bills:[...input.bills,{id:'personal-bill',changes:{remark:'wrong'}}]}],
    ['test-user','ledger.create',{requestId:manifest.prefix+'create',bills:[{bookId:'100',categoryId:'300',assetId:'personal-asset',remark:manifest.prefix+'支出'}]}],
    ['test-user','books.submit',{mode:'create',name:'个人账本',type:0,requestId:manifest.prefix+'book'}],
    ['test-user','books.setBaseCurrency',{baseCurrency:'USD',requestId:manifest.prefix+'base'}],
  ] as const)expect(()=>scope.authorize(uid,action,value)).toThrow(DomainError);
});
it('checks the bounded test policy again before a queued mutation can prepare or send',async()=>{
  const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);let prepared=0,sent=0;
  await app.repository(async repository=>{repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();const coordinator=new Coordinator({repository,clock,client:upstream.client,authorizeMutation:()=>{throw new DomainError('ACCEPTANCE_SCOPE_DENIED','not a test resource');}},new Map([['ledger.edit',{prepare:async()=>{prepared++;return {payload:{},items:[{id:'personal',affectedIds:['bill:personal']}],affectedIds:['bill:personal']};},send:async()=>{sent++;return {ec:'200',data:null,httpStatus:200};},applyReceipt:()=>({items:[{id:'personal',state:'succeeded'}]}),reconcile:async()=>({items:[]})}]]));const result=await coordinator.submit({action:'ledger.edit',scope:app.scope,requestId:'queued-before-policy',input:{}});expect(result.error?.code).toBe('ACCEPTANCE_SCOPE_DENIED');expect(prepared).toBe(0);expect(sent).toBe(0);});
});
it('invokes the released shared use case publicly while the private test authorizer remains restrictive',async()=>{
 const app=await createTestApp();await app.repository(async(_repository,storage)=>{const context=createActorContext(storage),input={requestId:manifest.prefix+'book',mode:'create' as const,name:'隔离测试账本',type:-1},run=vi.spyOn(context.books,'submit').mockResolvedValue({id:'released-operation',state:'queued'} as never);expect(await new AppRegistry(context).invoke('books.submit',input)).toMatchObject({status:'running',operationId:'released-operation'});expect(run).toHaveBeenCalledOnce();expect(await new AppRegistry(context,()=>{throw new DomainError('ACCEPTANCE_SCOPE_DENIED','outside test scope');}).invoke('books.submit',input)).toMatchObject({status:'error',error:{code:'ACCEPTANCE_SCOPE_DENIED'}});expect(run).toHaveBeenCalledOnce();});
});
it('checks all nested category ordering IDs instead of trusting a scoped book alone',()=>{
 const scope=new AcceptanceScope({...manifest,actions:['categories.reorder']});expect(()=>scope.authorize('test-user','categories.reorder',{bookId:'100',type:0,groups:[['300','personal-category']],requestId:manifest.prefix+'sort'})).toThrow('ACCEPTANCE_SCOPE_DENIED');
});
it('checks actual prepared financial references including encoded derived bill parameters',()=>{
 const scope=new AcceptanceScope(manifest),prepared=(bookId:string,assetId:string)=>({payload:{params:{uid:'test-user',diffparams:JSON.stringify({bookid:bookId,accountId:assetId})}},items:[],affectedIds:[]});expect(()=>scope.authorizePrepared('test-user',prepared('100','200'))).not.toThrow();expect(()=>scope.authorizePrepared('test-user',prepared('-1','200'))).toThrow('ACCEPTANCE_SCOPE_DENIED');expect(()=>scope.authorizePrepared('test-user',prepared('100','personal-asset'))).toThrow('ACCEPTANCE_SCOPE_DENIED');
});
it('does not send when the prepared payload exceeds the privately authorized resource scope',async()=>{
 const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);let sent=0;await app.repository(async repository=>{repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();const c=new Coordinator({repository,clock,client:upstream.client,authorizePrepared:()=>{throw new DomainError('ACCEPTANCE_SCOPE_DENIED','derived book is personal');}},new Map([['test.write',{prepare:async()=>({payload:{bookid:'-1'},items:[{id:'derived',affectedIds:['derived']}],affectedIds:['derived']}),send:async()=>{sent++;return {ec:'200',data:null,httpStatus:200};},applyReceipt:()=>({items:[{id:'derived',state:'succeeded'}]}),reconcile:async()=>({items:[]})}]]));expect((await c.submit({action:'test.write',requestId:'derived-scope',scope:app.scope,input:{}})).error?.code).toBe('ACCEPTANCE_SCOPE_DENIED');expect(sent).toBe(0);});
});
