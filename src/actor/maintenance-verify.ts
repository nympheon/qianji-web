import {DomainError} from '../shared/errors';
import type {createActorContext} from './context';
/** Invoked only over the private Cloudflare maintenance binding; all upstream work is read-only. */
export async function verifyMaintenance(context:ReturnType<typeof createActorContext>){
 if(!context.maintenance.paused())throw new DomainError('MAINTENANCE_NOT_PAUSED','先暂停写入再核查');
 const connection=await context.connection.check();if(connection.state!=='connected'||connection.problem)throw new DomainError('CONNECTION_REQUIRED','请先恢复有效的钱迹连接');
 const scope=context.connection.scope()!;
 for(const id of context.maintenance.view().unresolvedOperationIds){const operation=context.coordinator.getOperation(scope,id);if(operation&&operation.state!=='queued')await context.coordinator.reconcileOperation(scope,id);}
 // Rebuild after checking historical receipts so no old receipt can become the latest mirror.
 let job=await context.rebuild.rebuild(scope,['tags','ledger']);
 for(let chunk=0;job.state==='running'&&chunk<500;chunk++){await context.rebuild.resume(job.id);job=context.rebuild.getJob(scope,job.id)!;if(job.state==='running')await new Promise(resolve=>setTimeout(resolve,100));}
 if(job.state!=='succeeded')throw new DomainError('MAINTENANCE_CHECK_INCOMPLETE','账单及标签重建尚未完成，请保留暂停后继续核查');
 context.repository.sql.exec('UPDATE source_queries SET invalidated=1 WHERE uid=?',scope.uid).toArray();
 const requireSource=(view:{problem?:{code:string;message:string}})=>{if(view.problem)throw new DomainError(view.problem.code,view.problem.message);};
 requireSource(await context.books.list({includeHidden:true}));
 for(const status of [0,2] as const)requireSource(await context.assets.list({status,includeInstallments:true,limit:200},true));
 for(const direction of ['borrow','lend'] as const)for(const finished of [false,true])requireSource(await context.debt.list({direction,finished}));
 requireSource(await context.tags.list({includeArchived:true}));
 requireSource(await context.repeat.list({sort:0,ascending:false}));requireSource(await context.installments.list({sort:0,ascending:false}));requireSource(await context.savings.list({}));
 return context.maintenance.markChecked();
}
