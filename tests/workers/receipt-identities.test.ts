import {expect,it} from 'vitest';
import {createTestApp} from '../support/app';
import {TestClock,createUpstream} from '../support/upstream';
import {Coordinator} from '../../src/actor/coordinator';
import {commandDigest} from '../../src/operations/store';
import {resourceExisted,billExisted} from '../../src/operations/identity';
import {ResourceCache} from '../../src/storage/cache';
import {projectBill} from '../../src/features/sync/incremental';
import type {StoredOperation} from '../../src/operations/contract';

it.each([
 ['assets.submit','assets','asset'],['debt.create','assets','asset'],['books.submit','books','book'],
 ['assets.groups.submit','assets','assetGroup'],['categories.submit','ledger','category'],
 ['categories.submitMany','ledger','category'],['tags.submitTag','tags','tag'],['tags.submitGroup','tags','tagGroup'],
] as const)('keeps the pre-send identity proof for %s across restart and later catalog replacement',async(action,domain,kind)=>{
 const app=await createTestApp(),clock=new TestClock();let saved:StoredOperation;
 await app.repository(repository=>{
  const cache=new ResourceCache(repository,clock);cache.confirmResources(app.scope,domain,[{id:'old-id',kind,raw:{name:'old'}}]);
  const c=new Coordinator({repository,clock,client:createUpstream(clock,app.scope).client},new Map()),command={scope:app.scope,requestId:'proof',action,input:{}};
  saved=c.store.prepare(c.store.create(command,commandDigest(command)),{payload:{},affectedIds:['proof'],items:[{id:'proof',affectedIds:['proof']}]});
  const dataset=repository.dataset(app.scope,domain)!;repository.applyPage(app.scope,dataset.id,{upserts:[],deletes:[],resources:[{id:'new-id',kind,raw:{name:'later'}}],resourceDeletes:[{id:'old-id',kind}],pageState:null},domain);
 });
 await app.restart();await app.repository(repository=>{
  const c=new Coordinator({repository,clock,client:createUpstream(clock,app.scope).client},new Map()),op=c.store.get(app.scope,saved.id)!;
  expect(resourceExisted(op.prepared!,repository,app.scope,domain,kind,'old-id')).toBe(true);
  expect(resourceExisted(op.prepared!,repository,app.scope,domain,kind,'new-id',true)).toBe(false);
  const {identityBaseline:_proof,...legacy}=op.prepared!;expect(resourceExisted(legacy,repository,app.scope,domain,kind,'new-id')).toBe(true);
 });
});
it('keeps initial debt bill ID collisions detectable even when the original bill later disappears',async()=>{
 const app=await createTestApp(),clock=new TestClock();await app.repository(repository=>{
  repository.createDataset(app.scope,'ledger','ledger');repository.applyPage(app.scope,'ledger',{upserts:[projectBill({id:'old',bookid:'1',type:1,money:'1',time:1})],deletes:[],resources:[],pageState:null,complete:true});repository.switchDataset(app.scope,'ledger','ledger',null);
  const c=new Coordinator({repository,clock,client:createUpstream(clock,app.scope).client},new Map()),command={scope:app.scope,requestId:'debt-proof',action:'debt.create',input:{}};
  const op=c.store.prepare(c.store.create(command,commandDigest(command)),{payload:{},items:[{id:'debt',affectedIds:[]}],affectedIds:[]});
  repository.applyPage(app.scope,'ledger',{upserts:[projectBill({id:'new',bookid:'1',type:1,money:'1',time:1})],deletes:['old'],resources:[],pageState:null});
  expect(billExisted(op.prepared!,repository,app.scope,'old')).toBe(true);expect(billExisted(op.prepared!,repository,app.scope,'new',true)).toBe(false);
 });
});
