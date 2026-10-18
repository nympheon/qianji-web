import {createHash} from 'node:crypto';
import {DomainError} from '../shared/errors';
import type {ActorScope,Clock} from '../shared/model';
import type {Repository} from '../storage/database';
export interface MaintenanceEnvironment {paused?:boolean;restoreId?:string}
interface State {phase:'active'|'paused'|'restore-required'|'checked';enteredMs:number;restoreId:string|null;checkedMs:number|null;proof:string|null}
const key='maintenance:state';
export const maintenanceSources=[['books','book:list:-1'],['assets','asset:list:0'],['assets','asset:list:2'],...['51','52'].flatMap(type=>['0','1'].map(status=>['assets',`asset:loans:${type}:${status}`])),['tags','catalog:all'],['repeat','repeat:list:0:0'],['installments','installment:list:0:0'],['savings','saving:list']] as const;
export class Maintenance {
 constructor(private readonly repository:Repository,private readonly clock:Clock,private readonly environment:MaintenanceEnvironment={}){
  const state=this.state();
  if(environment.restoreId&&environment.restoreId!==state.restoreId)this.enterRestore(environment.restoreId);
  else if(environment.paused&&state.phase==='active')this.pause();
 }
 private state():State{const row=this.repository.sql.exec<{value:string}>('SELECT value FROM instance_meta WHERE key=?',key).toArray()[0];return row?JSON.parse(row.value) as State:{phase:'active',enteredMs:0,restoreId:null,checkedMs:null,proof:null};}
 private save(state:State){this.repository.sql.exec('INSERT INTO instance_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(state)).toArray();}
 paused(){return this.environment.paused===true||this.state().phase!=='active';}
 assertWritable(){if(this.paused())throw new DomainError('MAINTENANCE_PAUSED','维护或恢复核查中，写入尚未重新开放');}
 pause(){const state=this.state();this.save({...state,phase:'paused',enteredMs:this.clock.nowMs(),checkedMs:null,proof:null});return this.view();}
 private enterRestore(restoreId:string){
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(restoreId))throw new DomainError('RESTORE_ID_INVALID','恢复批次需要新的明确编号');
  this.repository.transaction(()=>{
   const error={code:'RESTORED_OPERATION_UNCERTAIN',message:'数据库已回滚；旧排队记录可能曾发送，只核查原操作，禁止重新发送'};
   for(const row of this.repository.sql.exec<{id:string;items:string}>("SELECT id,items FROM operations WHERE state IN('queued','sending','verifying')").toArray()){
    const items=(JSON.parse(row.items) as {state:string;error:unknown}[]).map(item=>['succeeded','failed'].includes(item.state)?item:{...item,state:'uncertain',error});
    this.repository.sql.exec("UPDATE operations SET state='uncertain',items=?,error=?,updated_ms=? WHERE id=?",JSON.stringify(items),JSON.stringify(error),this.clock.nowMs(),row.id).toArray();
   }
   this.repository.sql.exec('DELETE FROM jobs').toArray();
   this.repository.sql.exec('DELETE FROM sync_barrier').toArray();
   for(const table of ['sync_jobs','rebuild_jobs'])this.repository.sql.exec(`UPDATE ${table} SET state='failed',error=? WHERE state='running'`,JSON.stringify(error)).toArray();
   this.repository.sql.exec('UPDATE source_queries SET invalidated=1').toArray();
   this.repository.sql.exec('UPDATE datasets SET validated_at=NULL').toArray();
   this.save({phase:'restore-required',enteredMs:this.clock.nowMs(),restoreId,checkedMs:null,proof:null});
  });
 }
 private scope():ActorScope{const row=this.repository.sql.exec<{uid:string|null;connection_epoch:string|null;state:string;profile_raw:string|null}>('SELECT uid,connection_epoch,state,profile_raw FROM connection').one();if(!row.uid||!row.connection_epoch||row.state!=='connected')throw new DomainError('CONNECTION_REQUIRED','恢复核查需要有效的钱迹连接');const checked=row.profile_raw?Date.parse((JSON.parse(row.profile_raw) as {checkedAt?:string}).checkedAt??''):NaN;if(!Number.isFinite(checked)||checked<this.state().enteredMs)throw new DomainError('MAINTENANCE_CHECK_REQUIRED','请先实际检查登录状态');return {uid:row.uid,connectionEpoch:row.connection_epoch};}
 private fingerprint():string{
  const scope=this.scope(),state=this.state(),ledger=this.repository.dataset(scope,'ledger');if(!ledger?.complete||!ledger.validatedAt||Date.parse(ledger.validatedAt)<state.enteredMs)throw new DomainError('MAINTENANCE_CHECK_REQUIRED','请先完成恢复后的账单来源检查');
  for(const [domain,query]of maintenanceSources){const row=this.repository.sql.exec<{complete:number;invalidated:number;validated_ms:number|null;dataset_id:string}>('SELECT complete,invalidated,validated_ms,dataset_id FROM source_queries WHERE uid=? AND domain=? AND query_key=?',scope.uid,domain,query).toArray()[0];const active=this.repository.sql.exec<{dataset_id:string}>('SELECT dataset_id FROM active_datasets WHERE uid=? AND domain=?',scope.uid,domain).toArray()[0];if(!row||row.complete!==1||row.invalidated||row.validated_ms===null||row.validated_ms<state.enteredMs||row.dataset_id!==active?.dataset_id)throw new DomainError('MAINTENANCE_CHECK_REQUIRED','请完成账本、全部资产/借贷、标签及计划的实际来源核查');}
  const revisions=this.repository.sql.exec('SELECT d.domain,d.id,d.revision FROM datasets d JOIN active_datasets a ON a.uid=d.uid AND a.domain=d.domain AND a.dataset_id=d.id WHERE d.uid=? ORDER BY d.domain',scope.uid).toArray();
  const unknown=this.repository.sql.exec<{id:string}>("SELECT id FROM operations WHERE state IN('uncertain','partial','sending','verifying','queued') ORDER BY id LIMIT 1001").toArray().map(row=>row.id);if(unknown.length>1000)throw new DomainError('MAINTENANCE_REVIEW_LIMIT','待核查操作超过1000项，请先分批处理');
  return createHash('sha256').update(JSON.stringify([scope,state.restoreId,revisions,unknown])).digest('hex');
 }
 markChecked(){if(!this.paused())throw new DomainError('MAINTENANCE_NOT_PAUSED','先暂停写入再进行恢复核查');const proof=this.fingerprint();this.save({...this.state(),phase:'checked',checkedMs:this.clock.nowMs(),proof});return this.view();}
 resume(reviewDigest:string){const state=this.state();if(state.phase!=='checked'||state.checkedMs===null||this.clock.nowMs()-state.checkedMs<0||this.clock.nowMs()-state.checkedMs>300000)throw new DomainError('MAINTENANCE_CHECK_REQUIRED','解除暂停前需完成最近五分钟内的真实核查');if(this.environment.paused)throw new DomainError('MAINTENANCE_ENV_PAUSED','先移除Cloudflare环境中的维护暂停，再核对摘要解除暂停');if(reviewDigest!==state.proof||this.fingerprint()!==state.proof)throw new DomainError('MAINTENANCE_REVIEW_CHANGED','恢复核查摘要已变化，请重新检查原未知操作');this.save({...state,phase:'active'});return this.view();}
 view(){const state=this.state();return {...state,paused:this.paused(),unresolvedOperationIds:this.repository.sql.exec<{id:string}>("SELECT id FROM operations WHERE state IN('uncertain','partial','sending','verifying','queued') ORDER BY id LIMIT 1001").toArray().map(row=>row.id)};}
}
