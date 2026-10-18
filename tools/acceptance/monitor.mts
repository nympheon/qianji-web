import type {Repository} from '../../src/storage/database';
type Snapshot={monitorId:string;networkRequests:number;lastNetworkAt:string|null};
const key='private:acceptance:network-monitor:v1';
/** Test instrumentation only: never lose an attempted request on actor eviction. */
export class AcceptanceMonitor{
 constructor(private readonly repository:Repository){repository.sql.exec('INSERT OR IGNORE INTO instance_meta(key,value) VALUES (?,?)',key,JSON.stringify({monitorId:crypto.randomUUID(),networkRequests:0,lastNetworkAt:null})).toArray();}
 snapshot():Snapshot{return JSON.parse(this.repository.sql.exec<{value:string}>('SELECT value FROM instance_meta WHERE key=?',key).one().value) as Snapshot;}
 attempt(at:string){this.repository.transaction(()=>{const value=this.snapshot();value.networkRequests++;value.lastNetworkAt=at;this.repository.sql.exec('UPDATE instance_meta SET value=? WHERE key=?',JSON.stringify(value),key).toArray();});}
}
