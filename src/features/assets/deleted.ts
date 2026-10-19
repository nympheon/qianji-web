import type {Repository} from '../../storage/database';
import type {ActorScope} from '../../shared/model';

/** A missing cache entry alone never proves an asset was deleted. */
export function confirmedDeletedAsset(repository:Repository,scope:ActorScope,id:string):boolean{
 repository.assertScope(scope);
 if(repository.readResources(scope,'asset',{domain:'assets',ids:[id]}).items.length)return false;
 return repository.sql.exec(`SELECT 1 FROM operations o,json_each(o.items) item
  WHERE o.uid=? AND o.action='assets.delete' AND json_extract(o.input,'$.id')=?
  AND json_extract(o.prepared,'$.payload.kind')='delete'
  AND json_extract(o.prepared,'$.received.reply.ec')='200'
  AND json_extract(item.value,'$.id')=json_extract(o.prepared,'$.payload.logicalId')
  AND json_extract(item.value,'$.state')='succeeded' LIMIT 1`,scope.uid,id).toArray().length>0;
}
