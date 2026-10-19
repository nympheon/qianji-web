import type {Repository} from '../../storage/database';
import type {ActorScope,Clock} from '../../shared/model';
import type {ResourceKind} from '../../storage/resources';
import {ResourceCache,type CacheKey} from '../../storage/cache';
import {bookListKey} from '../books/source';
import {categoryKey} from '../categories/source';
import {tagCatalogKey,tagRowsKey} from '../tags/source';
import {asBillObject,numericText} from '../../shared/bill-wire';

export function optionSource(repository:Repository,clock:Clock,scope:ActorScope,key:CacheKey,kind:ResourceKind){
 const exists=repository.sql.exec('SELECT 1 FROM source_queries WHERE uid=? AND domain=? AND query_key=?',scope.uid,key.domain,key.queryKey).toArray().length>0;
 if(exists){const source=new ResourceCache(repository,clock).read(scope,key),items=source.items.filter(row=>row.kind===kind);return {items:items.slice(0,200),complete:source.complete&&items.length<=200,stale:source.stale};}
 const old=repository.readResources(scope,kind,{domain:key.domain,limit:200});return {items:old.items,complete:false,stale:true};
}
export const bookOptions=(repository:Repository,clock:Clock,scope:ActorScope)=>optionSource(repository,clock,scope,bookListKey,'book');
export function ledgerOptionSources(repository:Repository,clock:Clock,scope:ActorScope){
 const newest=repository.sql.exec<{query_key:string}>("SELECT query_key FROM source_queries WHERE uid=? AND domain='tags' AND query_key IN (?,?) AND complete=1 AND invalidated=0 ORDER BY validated_ms DESC,query_key=? DESC LIMIT 1",scope.uid,tagRowsKey.queryKey,tagCatalogKey.queryKey,tagCatalogKey.queryKey).toArray()[0];
 const books=bookOptions(repository,clock,scope),tags=optionSource(repository,clock,scope,newest?.query_key===tagRowsKey.queryKey?tagRowsKey:tagCatalogKey,'tag');
 const categories=new Map<string,import('../../storage/resources').ResourceRecord>();let complete=books.complete&&tags.complete;
 for(const book of books.items)for(const type of [0,1] as const){
  const source=optionSource(repository,clock,scope,categoryKey({bookId:book.id,type}),'category');complete&&=source.complete;
  for(const item of source.items){const raw=asBillObject(item.raw);if(raw.bookid!=null&&numericText(raw.bookid,'')!==book.id||raw.type!=null&&numericText(raw.type,'')!==String(type))continue;categories.set(item.id,item);}
 }
 return {books:books.items,tags:tags.items,categories:[...categories.values()].slice(0,200),complete:complete&&categories.size<=200};
}
