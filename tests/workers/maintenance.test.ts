import {expect,it} from 'vitest';
import {createTestApp} from '../support/app';
import {TestClock,createUpstream} from '../support/upstream';
import {Coordinator} from '../../src/actor/coordinator';
import {Maintenance,maintenanceSources} from '../../src/actor/maintenance';
import {ResourceCache} from '../../src/storage/cache';
import {createActorContext} from '../../src/actor/context';
import type {MutationHandler} from '../../src/operations/contract';
it('quarantines restored queued intents and never sends them on restart or after lifting the environment pause',async()=>{
 const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);let sent=0;
 const handler:MutationHandler={prepare:async()=>({payload:{},items:[{id:'restored',affectedIds:['restored']}],affectedIds:['restored']}),send:async()=>{sent++;return {ec:'200',data:null,httpStatus:200};},applyReceipt:()=>({items:[{id:'restored',state:'succeeded'}]}),reconcile:async()=>({items:[]})};
 await app.repository(async repository=>{const c=new Coordinator({repository,client:upstream.client,clock},new Map([['test.write',handler]]));const queued=await c.submit({scope:app.scope,action:'test.write',requestId:'queued-before-restore',input:{}});expect(queued.state).toBe('queued');const maintenance=new Maintenance(repository,clock,{paused:true,restoreId:'restore-run-1'});repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();const guarded=new Coordinator({repository,client:upstream.client,clock,writesPaused:()=>maintenance.paused()},new Map([['test.write',handler]]));await guarded.recover();await guarded.resumeJobs();expect(guarded.getOperation(app.scope,queued.id)?.state).toBe('uncertain');expect(sent).toBe(0);});
 await app.restart();await app.repository(repository=>{const maintenance=new Maintenance(repository,clock,{paused:false,restoreId:'restore-run-1'});expect(maintenance.paused()).toBe(true);expect(()=>maintenance.resume('unreviewed')).toThrow('MAINTENANCE_CHECK_REQUIRED');});expect(sent).toBe(0);
});
it('blocks pause-era submissions before creating another intent and preserves the ordinary restart identity',async()=>{
 const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);let device='';await app.repository(async repository=>{device=repository.sql.exec<{device_id:string}>('SELECT device_id FROM connection').one().device_id;const maintenance=new Maintenance(repository,clock,{paused:true});const c=new Coordinator({repository,clock,client:upstream.client,writesPaused:()=>maintenance.paused()},new Map());await expect(c.submit({scope:app.scope,action:'test.write',requestId:'during-pause',input:{}})).rejects.toThrow('MAINTENANCE_PAUSED');expect(repository.sql.exec('SELECT id FROM operations').toArray()).toHaveLength(0);});await app.restart();await app.repository(repository=>{expect(repository.sql.exec<{device_id:string}>('SELECT device_id FROM connection').one().device_id).toBe(device);expect(repository.dataset(app.scope,'ledger')).toBeNull();});
});
it('requires fresh official source checkpoints and an unchanged reviewed digest before reopening',async()=>{
 const app=await createTestApp(),clock=new TestClock();await app.repository(repository=>{
  const maintenance=new Maintenance(repository,clock,{paused:false});maintenance.pause();expect(()=>maintenance.markChecked()).toThrow('CONNECTION_REQUIRED');repository.sql.exec("UPDATE connection SET state='connected',profile_raw=?",JSON.stringify({checkedAt:clock.nowIso()})).toArray();expect(()=>maintenance.markChecked()).toThrow('MAINTENANCE_CHECK_REQUIRED');
  repository.createDataset(app.scope,'ledger','ledger');repository.applyPage(app.scope,'ledger',{upserts:[],deletes:[],resources:[],pageState:null,complete:true,validatedAt:clock.nowIso()});repository.switchDataset(app.scope,'ledger','ledger',null);const cache=new ResourceCache(repository,clock);for(const [domain,queryKey]of maintenanceSources){const key={domain:domain as import('../../src/storage/mirror').SyncDomain,queryKey};cache.applyRead(cache.captureRead(app.scope,key),{items:[],complete:true});}
  const checked=maintenance.markChecked();expect(checked.phase).toBe('checked');expect(()=>maintenance.resume('wrong-digest')).toThrow('MAINTENANCE_REVIEW_CHANGED');expect(maintenance.resume(checked.proof!).paused).toBe(false);
  maintenance.pause();const second=maintenance.markChecked();repository.sql.exec("UPDATE datasets SET revision=revision+1 WHERE domain='ledger'").toArray();expect(()=>maintenance.resume(second.proof!)).toThrow('MAINTENANCE_REVIEW_CHANGED');
 });
});
it('applies the external restore fence before the real actor context can recover its old queue',async()=>{
 const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);let requestId='';await app.repository(async(repository,storage)=>{
  const c=new Coordinator({repository,clock,client:upstream.client},new Map([['test.write',{prepare:async()=>({payload:{},items:[],affectedIds:[]}),send:async()=>{throw new Error('must not send');},applyReceipt:()=>({items:[]}),reconcile:async()=>({items:[]})}]]));
  const original=await c.submit({scope:app.scope,action:'test.write',requestId:'pre-rollback-queue',input:{}});requestId=original.id;repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();const context=createActorContext(storage,{QIANJI_MAINTENANCE:'paused',QIANJI_RESTORE_ID:'external-restore-002'});await context.coordinator.recover();await context.coordinator.resumeJobs();expect(context.coordinator.getOperation(app.scope,requestId)?.state).toBe('uncertain');expect(context.maintenance.view().phase).toBe('restore-required');await expect(context.coordinator.submit({scope:app.scope,action:'ledger.create',requestId:'new-while-restoring',input:{}})).rejects.toThrow('MAINTENANCE_PAUSED');expect(upstream.calls).toHaveLength(0);
 });
});
