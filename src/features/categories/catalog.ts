import type { z } from 'zod';
import type { OperationContext } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import type { Coordinator } from '../../actor/coordinator';
import type { ConnectionService } from '../connection/service';
import type { ResourceCache } from '../../storage/cache';
import { asBillObject } from '../../shared/bill-wire';
import { DomainError } from '../../shared/errors';
import { safeProblem } from '../../operations/runner';
import type { Problem } from '../../shared/reply';
import { restoreBillInput } from '../ledger/write';
import { categoryBatchSchema,categoryBatchDraftSchema,type CategoryBatchDraft,type CategoryBatchDraftView,type CategoryIconListView } from './catalog-contract';
const key={domain:'catalogs',resourceKind:'categoryIcon',queryKey:'category:icons'} as const;
export class CategoryCatalog{
  #pending:Promise<unknown>|null=null;
  constructor(private readonly dependencies:OperationContext&{connection:Pick<ConnectionService,'scope'>;cache:ResourceCache;coordinator?:Coordinator}){}
  private scope(){const scope=this.dependencies.connection.scope();if(!scope)throw new DomainError('CONNECTION_REQUIRED','请先连接钱迹');return scope;}
  async icons():Promise<CategoryIconListView>{const scope=this.scope(),{cache,repository,client}=this.dependencies;let source=cache.read(scope,key),problem:Problem|undefined;const connected=repository.sql.exec<{state:string}>('SELECT state FROM connection WHERE singleton=1').one().state==='connected';if(source.stale&&connected){if(!this.#pending){const stamp=cache.captureRead(scope,key);this.#pending=(async()=>{const reply=await client.request('category.icons',{uid:scope.uid},scope);if(!Array.isArray(reply.data)||reply.hasMore||reply.data.length>5000)throw new DomainError('CATEGORY_ICONS_INVALID','官方图标目录未完整返回');let group='';const items=reply.data.flatMap((value,index)=>{const raw=asBillObject(value);if(typeof raw.group==='string'&&raw.group){group=raw.group;return [];}if(typeof raw.icon!=='string'||!raw.icon)return [];return [{id:String(index),kind:'categoryIcon' as const,raw:{icon:raw.icon,name:typeof raw.name==='string'?raw.name:raw.icon,group}}];});if(cache.applyRead(stamp,{items,complete:true})!=='applied')throw new DomainError('SOURCE_SUPERSEDED','图标目录读取期间发生变化');})();}const pending=this.#pending;try{await pending;}catch(error){problem=safeProblem(error);}finally{if(this.#pending===pending)this.#pending=null;}source=cache.read(scope,key);}return {items:source.items.map(item=>{const raw=asBillObject(item.raw);return {icon:String(raw.icon),name:String(raw.name),group:String(raw.group)};}),freshness:{revision:source.revision,complete:source.complete,stale:source.stale||!connected||!!problem,syncedAt:source.validatedAt===null?null:new Date(source.validatedAt).toISOString()},...(problem?{problem}:{})};}
  submitMany(input:z.infer<typeof categoryBatchSchema>,meta:{requestId:string}){if(!this.dependencies.coordinator)throw new DomainError('ACTION_UNAVAILABLE','批量分类写入尚未准备');return this.dependencies.coordinator.submit({action:'categories.submitMany',scope:this.scope(),requestId:meta.requestId,input});}
  getDraft(id:string):CategoryBatchDraftView|null{const scope=this.scope(),raw=this.dependencies.repository.readDraft(scope,`category-batch:${id}`);if(!raw)return null;const draft=categoryBatchDraftSchema.parse(restoreBillInput(raw)),operation=this.dependencies.coordinator?.store.find(scope,draft.requestId);return {draft,operationId:operation?.id??null};}
  saveDraft(id:string,value:CategoryBatchDraft):CategoryBatchDraftView{const draft=categoryBatchDraftSchema.parse(value),scope=this.scope(),prior=this.getDraft(id),operation=prior?.operationId?this.dependencies.coordinator?.getOperation(scope,prior.operationId):null;if(operation&&!operationIsFinal(operation))throw new DomainError('DRAFT_OPERATION_PENDING','原批量分类尚未核清，请查看原操作');if(this.dependencies.coordinator?.store.find(scope,draft.requestId))throw new DomainError('DRAFT_ALREADY_SUBMITTED','原草稿已提交，请查看原操作');this.dependencies.repository.saveDraft(scope,`category-batch:${id}`,draft);return {draft,operationId:null};}
}
