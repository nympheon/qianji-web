import type { Jobs } from '../actor/jobs';
import type { MutationHandler, OperationContext, StoredOperation } from './contract';
import type { OperationStore } from './store';
import { safeProblem } from './runner';

export async function reconcileMutation(operation: StoredOperation, handler: MutationHandler, context: OperationContext, store: OperationStore, jobs: Jobs): Promise<StoredOperation> {
  if (operation.state === 'queued') return operation;
  if (!operation.items.some((item) => item.state === 'uncertain' || item.state === 'sending')) { jobs.remove(operation.id); return operation; }
  context.repository.assertScope(operation.scope);
  const received=operation.prepared?.received;
  if(received&&!received.applied){
    try{
      const reply={...received.reply,httpStatus:Number(received.reply.httpStatus)};
      operation=context.repository.transaction(()=>store.markReceiptApplied(store.apply(operation,handler.applyReceipt(operation.prepared!,reply,{...context,client:context.client.asReadOnly()})),true));
    }catch(error){operation=store.markUnresolved(operation,'uncertain',safeProblem(error));}
    if(!operation.items.some(item=>item.state==='uncertain'||item.state==='sending')){jobs.remove(operation.id);return operation;}
  }
  try {
    const result = await handler.reconcile(operation, { ...context, client: context.client.asReadOnly() });
    context.repository.assertScope(operation.scope);
    operation = context.repository.transaction(() => {
      const update = result.receipt && operation.prepared
        ? handler.applyReceipt(operation.prepared, result.receipt, {...context,client:context.client.asReadOnly()}) : result;
      return store.apply(operation, update);
    });
  } catch (error) {
    operation = store.markUnresolved(operation, 'uncertain', safeProblem(error));
  }
  // One finite read pass. Remaining uncertainty waits for explicit use, not an alarm loop.
  jobs.remove(operation.id);
  return operation;
}
