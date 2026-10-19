import type {AcceptanceManifest,TestResource} from './scope.mts';
import {DomainError} from '../../src/shared/errors';
import {asBillObject,numericText,type BillObject} from '../../src/shared/bill-wire';
import {compareMoney} from '../../src/shared/numbers';
export function cleanupWriteStep(step:string,operation:{state:string;sendCount:number;error:{code:string}|null}|null):string{
 return step.startsWith('cleanup-')&&!step.endsWith('-version-refresh')&&operation?.state==='failed'&&operation.sendCount===0&&operation.error?.code==='DRAFT_SOURCE_CHANGED'?step+'-version-refresh':step;
}
export function assertOrphanSavingProvenance(manifest:AcceptanceManifest,proof:{uid:string;sendCount:number;payload:BillObject},raw:BillObject):void{
 const fail=()=>{throw new DomainError('CLEANUP_ID_UNPROVEN','旧测试计划的创建前快照与完整配置不足以证明来源');};
 const p=proof.payload,params=asBillObject(p.params),rule=asBillObject(params.rule),actual=asBillObject(raw.rule);
 if(proof.uid!==manifest.uid||numericText(raw.userid,'')!==manifest.uid||proof.sendCount!==1||p.kind!=='submit'||p.creating!==true||p.before!==null||!Array.isArray(p.beforeIds)||p.beforeIds.length!==0)fail();
 if(typeof raw.planid!=='string'||!raw.planid||typeof params.name!=='string'||!params.name.startsWith(manifest.prefix)||!['name','currency','mode','remark','color'].every(key=>params[key]===raw[key])||params.mode!=='custom'||params.icon!==''||raw.icon!=='http://res3.qianjiapp.com/cate_phone.png')fail();
 if(rule.mode!==actual.mode||compareMoney(numericText(rule.total,''),numericText(actual.total,''))!==0||numericText(rule.start,'')!==numericText(actual.start,'')||numericText(rule.end,'0')!==numericText(actual.end,'0')||!Array.isArray(raw.transactions)||raw.transactions.length!==0)fail();
}
export function assertCleanupTarget(manifest:AcceptanceManifest,uid:string,kind:TestResource,id:string,referencedBookIds:readonly string[]):void{
 if(uid!==manifest.uid)throw new DomainError('ACCEPTANCE_SCOPE_DENIED','清理账号与验收账号不同');
 if(!manifest.resources[kind]?.includes(id))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','清理目标没有本次新建清单的身份证明');
 if(referencedBookIds.some(bookId=>!manifest.resources.book?.includes(bookId)))throw new DomainError('ACCEPTANCE_SCOPE_DENIED','清理目标关联到非测试账本');
}
