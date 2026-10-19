import { DurableObject } from 'cloudflare:workers';
import production from '../../src/worker/index';
import { createActorContext } from '../../src/actor/context';
import { AppRegistry } from '../../src/app/registry';
import type { Env } from '../../src/worker/env';
import type { PasswordLoginInput } from '../../src/features/connection/contract';
import type { ImageReferenceInput } from '../../src/features/attachments/contract';
import { restoreBillInput } from '../../src/features/ledger/write';
import { asBillObject,billExtra,numericText } from '../../src/shared/bill-wire';
import { DomainError } from '../../src/shared/errors';
import { ProtocolError } from '../../src/protocol/errors';
import type { ActionName,ActionInput,ActionOutputs } from '../../src/contracts/actions';
import type { OperationView } from '../../src/operations/contract';
import { AcceptanceScope,type AcceptanceManifest,type TestResource } from './scope.mts';
import { caseNames,type CaseName } from './contract.mts';
import { runCase,testActions } from './cases.mts';
import {AcceptanceMonitor} from './monitor.mts';
import {repeatView} from '../../src/features/repeat/source';
import {installmentView} from '../../src/features/installments/source';
import {isLosslessNumber} from 'lossless-json';
import {assetView} from '../../src/features/assets/model';
import {bookView} from '../../src/features/books/model';

interface Manifest extends AcceptanceManifest {
 aliases:Record<string,string>;
 intents:Record<string,{action:ActionName;input:Record<string,unknown>}>;
 observations?:Record<string,unknown>;
}
type Trace={operation:string;ec:string;shape:unknown;upstreamCode?:string;upstreamSubcode?:string};
const manifestKey='private:acceptance:20261019';
function shape(value:unknown,depth=0):unknown{
 if(Array.isArray(value))return {array:value.length,...(value.length&&depth<2?{first:shape(value[0],depth+1)}:{})};
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/token|password|phone|email/i.test(key)).slice(0,30).map(([key,child])=>[key,depth<2?shape(child,depth+1):typeof child]));
 return value===null?'null':typeof value;
}

/** This local entry is excluded from the production import graph and deploy config. */
export class QianjiState extends DurableObject<Env>{
 private readonly context:ReturnType<typeof createActorContext>;
 #tail:Promise<unknown>=Promise.resolve();
 #trace:Trace[]=[];
 #dropBillReceipt=false;
 #billPosts=0;
 private readonly monitor:AcceptanceMonitor;
 constructor(state:DurableObjectState,env:Env){
  super(state,env);
  this.context=createActorContext(state.storage,env,undefined,{authorizeMutation:command=>{
   const policy=this.policy(),input=restoreBillInput(command.input);
   policy.authorize(command.scope.uid,command.action,{...(input as Record<string,unknown>),requestId:command.requestId});
  },authorizePrepared:(command,prepared)=>this.policy().authorizePrepared(command.scope.uid,prepared),fetch:async(url,init)=>{
   this.monitor.attempt(new Date().toISOString());
   const billPost=new URL(url).pathname==='/bill/syncall';if(billPost)this.#billPosts++;
   const response=await fetch(url,init);
   if(billPost&&this.#dropBillReceipt){this.#dropBillReceipt=false;const accepted=await response.clone().json() as {ec:unknown};if(response.ok&&String(accepted.ec)==='200'){this.#trace.push({operation:'wire:bill.receiptDropped',ec:'200',shape:null});throw new Error('simulated accepted response loss');}}
   if(new URL(url).pathname==='/repeat_task/toggle')try{const wire=await response.clone().json() as {ec:unknown;data?:unknown};this.#trace.push({operation:'wire:repeat.toggle',ec:String(wire.ec),shape:shape(wire.data??null)});}catch{this.#trace.push({operation:'wire:repeat.toggle',ec:'UNREADABLE',shape:null});}
   return response;
  }});
  this.monitor=new AcceptanceMonitor(this.context.repository);
  const request=this.context.client.request.bind(this.context.client);
  this.context.client.request=async(...args)=>{
   try{const reply=await request(...args);this.#trace.push({operation:args[0],ec:reply.ec,shape:shape(reply.data)});return reply;}
   catch(error){this.#trace.push({operation:args[0],ec:error instanceof DomainError?error.code:'REQUEST_FAILED',shape:null,...(error instanceof ProtocolError&&error.upstreamCode?{upstreamCode:error.upstreamCode}:{}),...(error instanceof ProtocolError&&error.upstreamSubcode?{upstreamSubcode:error.upstreamSubcode}:{})});throw error;}
  };
  state.blockConcurrencyWhile(()=>this.context.coordinator.recover());
 }
 ping(){return this.context.repository.sql.exec<{value:string}>("SELECT value FROM instance_meta WHERE key='instance_id'").one().value;}
 login(input:PasswordLoginInput){return this.context.connection.login(input);}
 imageSource(input:ImageReferenceInput){return this.context.attachments.source(input);}
 async call(action:string,input:unknown,meta:unknown={}){return JSON.stringify(await new AppRegistry(this.context).invoke(action,input,meta));}
 async alarm(){await this.context.coordinator.resumeJobs();}
 private load():Manifest|null{
  const row=this.context.repository.sql.exec<{value:string}>('SELECT value FROM instance_meta WHERE key=?',manifestKey).toArray()[0];
  return row?JSON.parse(row.value) as Manifest:null;
 }
 private save(manifest:Manifest){this.context.repository.sql.exec('INSERT INTO instance_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',manifestKey,JSON.stringify(manifest)).toArray();}
 private policy(){const manifest=this.load();if(!manifest)throw new DomainError('ACCEPTANCE_NOT_BOUND','尚未绑定测试范围');return new AcceptanceScope(manifest);}
 accept(name:CaseName):Promise<unknown>{const next=this.#tail.then(()=>this.execute(name));this.#tail=next.catch(()=>undefined);return next;}
 private async execute(name:CaseName){
  this.#trace=[];const operations:OperationView[]=[],partialReads:string[]=[];
  try{
   const account=this.context.connection.scope();if(!account)throw new DomainError('CONNECTION_REQUIRED','本地连接尚未登录');
   let manifest=this.load();
   if(!manifest){manifest={uid:account.uid,prefix:'验261019A',actions:[...testActions],resources:{},aliases:{},intents:{}};this.save(manifest);}
   if(manifest.uid!==account.uid)throw new DomainError('ACCEPTANCE_SCOPE_DENIED','当前账号与测试范围不同');
   manifest.actions=[...testActions];this.save(manifest);
   if(name==='prepay-card-inspect'){
    const operation=this.context.coordinator.store.find(account,manifest.prefix+':installment-fx-prepay-card-create'),reply=operation?.prepared?.received?.reply,raw=asBillObject(asBillObject(reply?.data).asset),expected=asBillObject(asBillObject(operation?.prepared?.payload).raw);
    if(numericText(raw.userid,'')!==account.uid||!String(raw.name).startsWith(manifest.prefix)||!String(expected.name).startsWith(manifest.prefix))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','仅允许检查新提前还款测试卡');
    return {state:'ready',expected:assetView(expected),actual:assetView(raw),expectedNameLength:String(expected.name).length,actualNameLength:String(raw.name).length};
   }
   if(name==='refund-native-none-inspect'){
    const operation=this.context.coordinator.store.find(account,manifest.prefix+':refund-fx-native-none'),reply=operation?.prepared?.received?.reply,rows=reply?.data;
    if(!Array.isArray(rows))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','缺少已保存测试回执');
    const native=rows.map(asBillObject).find(row=>numericText(row.type,'')==='20'&&String(row.remark)===manifest.prefix+'refund-fxnative-none');
    if(!native||numericText(native.bookid,'')!==manifest.aliases.book)throw new DomainError('ACCEPTANCE_SCOPE_DENIED','回执不在测试范围');
    const extra=billExtra(native),curr=extra.curr==null?{}:asBillObject(extra.curr);return {state:'ready',currency:{ss:curr.ss??null,ts:curr.ts??null,bs:curr.bs??null,sv:numericText(curr.sv,'absent'),tv:numericText(curr.tv,'absent'),bv:numericText(curr.bv,'absent')},extraKeys:Object.keys(extra),keys:Object.keys(curr),images:native.images,remark:native.remark};
   }
   if(name==='book-template-inspect'){
    const step=Object.keys(manifest.intents).find(key=>key.startsWith('book-template-')&&key.endsWith('-create'));
    const operation=step?this.context.coordinator.store.find(account,manifest.prefix+':'+step):null,reply=operation?.prepared?.received?.reply,raw=asBillObject(reply?.data);
    if(!String(raw.name).startsWith(manifest.prefix))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','仅允许检查本次新测试账本');
    return {state:'ready',step,expected:restoreBillInput(asBillObject(operation?.prepared?.payload).expected!),actual:bookView(raw,account.uid)};
   }
   if(name==='credit-inspect'){
    const operation=this.context.coordinator.store.find(account,manifest.prefix+':credit-metadata-b-false'),reply=operation?.prepared?.received?.reply,raw=asBillObject(asBillObject(reply?.data).asset);
    if(numericText(raw.id,'')!==manifest.aliases['credit-metadata-b']||numericText(raw.userid,'')!==account.uid)throw new DomainError('ACCEPTANCE_SCOPE_DENIED','仅允许检查本次测试卡');
    return {state:'ready',expected:assetView(asBillObject(asBillObject(operation?.prepared?.payload).raw)),actual:assetView(raw),sharedWireType:typeof asBillObject(raw.credit).shareid,sharedWireValue:numericText(asBillObject(raw.credit).shareid,'absent')};
   }
   if(name==='installment-inspect'){
    const operation=this.context.coordinator.store.find(account,manifest.prefix+':binding-installments-create'),reply=operation?.prepared?.received?.reply,raw=asBillObject(asBillObject(reply?.data).install);
    if(numericText(raw.userid,'')!==account.uid||!String(raw.name).startsWith(manifest.prefix))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','仅允许检查专用分期回执');
    return {state:'ready',expected:restoreBillInput(asBillObject(operation?.prepared?.payload).input!),actual:installmentView(raw),feePlacementWireType:typeof asBillObject(raw.data).feetype};
   }
   if(name==='repeat-inspect'){
    const operation=['repeat-extended-bystep-create','repeat-extended-week-create'].map(step=>this.context.coordinator.store.find(account,manifest.prefix+':'+step)).find(row=>row?.prepared?.received);
    const reply=operation?.prepared?.received?.reply,task=asBillObject(asBillObject(reply?.data).task),fields=asBillObject(operation?.prepared?.payload).fields;
    if(numericText(task.userid,'')!==account.uid||!String(asBillObject(task.data).remark).startsWith(manifest.prefix))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','仅允许检查已绑定的测试回执');
    const safe=(value:unknown):unknown=>isLosslessNumber(value)?value.value:Array.isArray(value)?value.map(safe):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,safe(child)])):value;
    const {category:_category,...data}=asBillObject(task.data);
    return {state:'ready',case:name,expected:restoreBillInput(fields!),actual:repeatView(task),data:safe(data),ruleTypes:(asBillObject(data.repeat).value as unknown[]).map(value=>isLosslessNumber(value)?'number':typeof value)};
   }
   const current=manifest,registry=new AppRegistry(this.context,(action,input)=>this.policy().authorize(account.uid,action,input));
   const read=async<A extends ActionName>(action:A,input:ActionInput<A>,allowFreshPartial=false):Promise<ActionOutputs[A]>=>{
    const reply=await registry.invoke(action,input);
    const acceptedPartial=allowFreshPartial&&reply.status==='partial'&&!!reply.freshness?.syncedAt&&Date.now()-Date.parse(reply.freshness.syncedAt)<60000;
    if(reply.error||!reply.data||reply.status!=='ready'&&!acceptedPartial)throw new DomainError(reply.error?.code??'ACCEPTANCE_SOURCE_INCOMPLETE',reply.error?.message??`${action} 尚未完整返回`);
    if(acceptedPartial)partialReads.push(action);
    return reply.data as ActionOutputs[A];
   };
   const write=async(step:string,action:ActionName,input:Record<string,unknown>,expectedPartialCodes:readonly string[]=[])=>{
    const requestId=current.prefix+':'+step,prior=current.intents[step];
    if(prior&&prior.action!==action)throw new DomainError('ACCEPTANCE_INTENT_CHANGED','原验收步骤不能更换操作');
    if(!prior){const {dataBase64:_bytes,...metadata}=input;current.intents[step]={action,input:action==='attachments.upload'?metadata:input};this.save(current);}
    const stored=prior?this.context.coordinator.store.find(account,requestId):null;
    if(prior)this.policy().authorize(account.uid,action,{...prior.input,requestId});
    // Original journal entries remain inspectable when a later schema disallows their old input.
    const reply=stored&&['uncertain','partial','succeeded','failed'].includes(stored.state)?{data:this.context.coordinator.getOperation(account,stored.id),error:null}:await registry.invoke(action,{...(prior?.input??input),...(action==='attachments.upload'?{dataBase64:input.dataBase64}:{}),requestId});
    if(!reply.data)throw new DomainError(reply.error?.code??'ACCEPTANCE_WRITE_BLOCKED',reply.error?.message??'验收操作未返回结果');
    let operation=reply.data as OperationView;operations.push(operation);
    if((operation.state==='uncertain'||operation.state==='partial')&&operation.items.some(item=>item.state==='uncertain')){
     await synchronize();
     operation=await this.context.coordinator.reconcileOperation(account,operation.id);operations.push(operation);
    }
    const expectedPartial=operation.state==='partial'&&operation.items.every(item=>item.state==='succeeded'||item.state==='failed'&&expectedPartialCodes.includes(item.error?.code??''));
    const expectedFailure=operation.state==='failed'&&operation.items.length>0&&operation.items.every(item=>item.state==='failed'&&expectedPartialCodes.includes(item.error?.code??''));
    if(operation.state!=='succeeded'&&!expectedPartial&&!expectedFailure)throw new DomainError(operation.error?.code??'ACCEPTANCE_OPERATION_UNCONFIRMED',`原操作 ${operation.id} 为 ${operation.state}，停止后续写入`);
    return operation;
   };
   const known=(alias:string)=>{const id=current.aliases[alias];if(!id)throw new DomainError('ACCEPTANCE_PREREQUISITE',`先完成测试资源：${alias}`);return id;};
   const remember=(alias:string,kind:TestResource,id:string)=>{
    if(current.aliases[alias]&&current.aliases[alias]!==id)throw new DomainError('ACCEPTANCE_ALIAS_CHANGED','原测试资源不能被替换');
    const fromReceipt=operations.some(op=>Object.values(op.idMap??{}).includes(id)||kind==='bill'&&(['ledger.create','ledger.transfer','ledger.repayCard'].includes(op.action)&&op.items.some(item=>item.id===id&&item.state==='succeeded')||['assets.adjustBalance','installments.create','repeat.submit'].includes(op.action)&&op.state==='succeeded'&&op.affectedIds.includes(id)));
    if(kind==='bill'){const row=this.context.repository.readBill(account,id);if(!row||!current.resources.book?.includes(row.bookId))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','账单不在专用测试账本中');}
    const category=kind==='category'?this.context.repository.readResources(account,'category',{domain:'ledger',ids:[id]}).items[0]:null;
    const fromTestBook=category&&current.resources.book?.includes(numericText(asBillObject(category.raw).bookid,''));
    const fromTestPlan=kind==='pack'&&(['repeat','installment'] as const).some(planKind=>(current.resources[planKind]??[]).some(planId=>{
     const row=this.context.repository.readResources(account,planKind,{domain:planKind==='repeat'?'repeat':'installments',ids:[planId]}).items[0];
     return row&&numericText(asBillObject(row.raw).packid,'')===id;
    }));
    if(!fromReceipt&&!fromTestBook&&!fromTestPlan)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','不能把无新建回执的既有资源加入测试清单');
    current.aliases[alias]=id;current.resources[kind]=[...new Set([...(current.resources[kind]??[]),id])];this.save(current);
   };
   const synchronize=async()=>{
    for(const domain of ['tags','ledger'] as const){
     const last=this.context.repository.sql.exec<{finished:number|null}>('SELECT MAX(finished_ms) AS finished FROM sync_jobs WHERE uid=? AND domain=?',account.uid,domain).one().finished;
     if(last!==null&&Date.now()-last<5000)await new Promise(resolve=>setTimeout(resolve,5000-(Date.now()-last)));
     let job=await this.context.sync.start({domain,mode:'incremental'});
     for(let chunk=0;job.state==='running'&&chunk<100;chunk++){await this.context.sync.resume(job.id);job=this.context.sync.getJob(account,job.id)!;}
     if(job.state!=='succeeded')throw new DomainError('ACCEPTANCE_SYNC_INCOMPLETE','只读回拉尚未完成，停止后续写入');
    }
   };
   const checkpoint=<T,>(key:string,value:T):T=>{const observations=current.observations??={};if(Object.hasOwn(observations,key))return observations[key] as T;observations[key]=value;this.save(current);return value;};
   const phase=async<T,>(key:string,run:()=>Promise<T>):Promise<T>=>{const phases=(current.observations??={});const id='phase:'+key;if(Object.hasOwn(phases,id))return phases[id] as T;const value=await run();phases[id]=value??null;this.save(current);return value;};
   const requireNotSentFailure=(step:string,code:string)=>{const operation=this.context.coordinator.store.find(account,current.prefix+':'+step);if(!operation||operation.state!=='failed'||operation.sendCount!==0||operation.error?.code!==code)throw new DomainError('ACCEPTANCE_RETRY_DENIED','只有明确未发送且错误完全匹配的准备失败才可建立后续测试意图');};
   const result=await runCase(name,{phase,requireNotSentFailure,hasIntent:step=>!!current.intents[step],prefix:current.prefix,read,write,remember,known,synchronize,checkpoint,invalidateSource:key=>this.context.cache.invalidateSource(account,key),optional:alias=>current.aliases[alias],billPostCount:()=>this.#billPosts,armReceiptLoss:()=>{if(name!=='receipt-loss')throw new DomainError('ACCEPTANCE_SCOPE_DENIED','故障仅限专用响应丢失场景');this.#dropBillReceipt=true;}});
   return {...result,case:name,resources:Object.fromEntries(Object.entries(current.resources).map(([kind,ids])=>[kind,ids?.length??0])),operations,partialReads,trace:this.#trace,...this.monitor.snapshot(),observedAt:new Date().toISOString()};
  }catch(error){return {case:name,state:'error',error:error instanceof DomainError?{code:error.code,message:error.detail}:{code:'ACCEPTANCE_FAILED',message:'本地验收未完成'},operations,trace:this.#trace};}
 }
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/__acceptance'){
   if(url.hostname!=='127.0.0.1'||request.method!=='POST')return new Response(null,{status:404});
   const text=await request.text();if(text.length>256)return new Response(null,{status:413});
   let name:unknown;try{name=(JSON.parse(text) as {case:unknown}).case;}catch{return new Response(null,{status:400});}
   if(!caseNames.includes(name as CaseName))return new Response(null,{status:400});
   const actor=env.QIANJI_STATE.getByName('personal') as unknown as {accept(name:CaseName):Promise<unknown>};
   return Response.json(await actor.accept(name as CaseName),{headers:{'cache-control':'no-store'}});
  }
  return production.fetch(request,env,ctx);
 }
} satisfies ExportedHandler<Env>;
