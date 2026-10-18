import type {ActorScope} from '../shared/model';
import type {Repository} from '../storage/database';
import type {ResourceKind} from '../storage/resources';
import type {SyncDomain} from '../storage/mirror';
import type {PreparedMutation} from './contract';
const targets:Record<string,readonly [SyncDomain,ResourceKind]>={
 'assets.submit':['assets','asset'],'debt.create':['assets','asset'],'books.submit':['books','book'],
 'assets.groups.submit':['assets','assetGroup'],'categories.submit':['ledger','category'],
 'categories.submitMany':['ledger','category'],'tags.submitTag':['tags','tag'],'tags.submitGroup':['tags','tagGroup'],
};
/** Saved before sending; later reads must not turn a new receipt ID into an old ID. */
export function captureIdentityBaseline(repository:Repository,scope:ActorScope,action:string):PreparedMutation['identityBaseline']{
 const target=targets[action];if(!target)return undefined;
 const [domain,kind]=target,dataset=repository.dataset(scope,domain);
 const resources=repository.sql.exec<{id:string}>('SELECT id FROM resources WHERE uid=? AND domain=? AND dataset_id=? AND kind=?',scope.uid,domain,dataset?.id??'unloaded',kind).toArray().map(row=>row.id);
 const ledger=repository.dataset(scope,'ledger');
 return {domain,kind,resources,...(action==='debt.create'?{bills:repository.sql.exec<{id:string}>("SELECT id FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=?",scope.uid,ledger?.id??'unloaded').toArray().map(row=>row.id)}:{})};
}
export function resourceExisted(prepared:PreparedMutation,repository:Repository,scope:ActorScope,domain:SyncDomain,kind:ResourceKind,id:string,historical=false):boolean{
 const proof=prepared.identityBaseline;
 const proven=proof?.domain===domain&&proof.kind===kind;
 if(proven&&proof.resources.includes(id))return true;
 return historical&&proven?false:repository.readResources(scope,kind,{domain,ids:[id]}).items.length>0;
}
export function billExisted(prepared:PreparedMutation,repository:Repository,scope:ActorScope,id:string,historical=false):boolean{
 const before=prepared.identityBaseline?.bills;if(before?.includes(id))return true;
 return historical&&before?false:!!repository.readBill(scope,id);
}
