import { DomainError } from '../shared/errors';
import type { Problem } from '../shared/reply';
import { ProtocolError } from '../protocol/errors';
import type { Jobs } from '../actor/jobs';
import type { MutationHandler, OperationContext, StoredOperation } from './contract';
import type { OperationStore } from './store';

export function safeProblem(error: unknown): Problem {
  return error instanceof DomainError ? { code: error.code, message: error.detail }
    : { code: 'OPERATION_INTERRUPTED', message: '操作结果需要核查' };
}
export async function runMutation(operation: StoredOperation, handler: MutationHandler, context: OperationContext, store: OperationStore, jobs: Jobs): Promise<StoredOperation> {
  const { repository } = context;
  if (operation.state !== 'queued' || operation.sendCount > 0) return operation;
  repository.assertScope(operation.scope);
  try {
    if(context.writesPaused?.())throw new DomainError('MAINTENANCE_PAUSED','维护核查期间禁止发送');
    context.authorizeMutation?.({scope:operation.scope,requestId:operation.requestId,action:operation.action,input:operation.input});
    repository.assertDraftCurrency(operation.scope,operation.requestId);
    const prepared = await handler.prepare({ scope: operation.scope, requestId: operation.requestId, action: operation.action, input: operation.input }, context);
    repository.assertScope(operation.scope);
    context.authorizePrepared?.({ scope: operation.scope, requestId: operation.requestId, action: operation.action, input: operation.input }, prepared);
    operation = store.prepare(operation, prepared);
  } catch (error) {
    operation = store.markUnresolved(operation, 'failed', safeProblem(error));
    jobs.remove(operation.id); return operation;
  }
  if (store.conflict(operation)) {
    jobs.remove(operation.id);
    return store.setError(operation, { code: 'TARGET_UNCERTAIN', message: '相关操作结果尚未核清，已保留排队操作' });
  }
  try { if(context.writesPaused?.())throw new DomainError('MAINTENANCE_PAUSED','维护核查期间禁止发送');const command={scope:operation.scope,requestId:operation.requestId,action:operation.action,input:operation.input}; context.authorizeMutation?.(command); context.authorizePrepared?.(command,operation.prepared!); }
  catch(error){ jobs.remove(operation.id); return store.markUnresolved(operation,'failed',safeProblem(error)); }
  // This durable marker is deliberately conservative, even if a crash occurs before fetch.
  operation = repository.transaction(() => store.markSending(operation));
  const currentOperation = () => store.get(operation.scope, operation.id)!;
  let batchCaptured=false;
  const sendContext: OperationContext = { ...context, currentOperation,
    captureReceipt:(reply,batchIds,sentBatch)=>{store.saveReceived(currentOperation(),reply,batchIds,sentBatch);batchCaptured=true;},
    checkpoint: (prepared, update) => { repository.transaction(() => {const current=currentOperation(),proof=current.prepared;const saved=store.checkpoint(current,{...prepared,...(proof?.received?{received:proof.received}:{}),...(proof?.batchReceipts?{batchReceipts:proof.batchReceipts}:{})},typeof update === 'function' ? update() : update);if(proof?.received?.batchIds)store.markReceiptApplied(saved);}); },
  };
  try {
    const reply = await handler.send(operation.prepared!, sendContext);
    repository.assertScope(operation.scope);
    operation = currentOperation();
    if(!batchCaptured)operation = store.saveReceived(operation,reply);
    if(!batchCaptured||!operation.prepared?.received?.applied)operation = repository.transaction(() => store.markReceiptApplied(store.apply(operation, handler.applyReceipt(operation.prepared!, reply, {...context,client:context.client.asReadOnly()}))));
    else operation=store.apply(operation,{items:[]});
  } catch (error) {
    operation = currentOperation();
    const knownRejected = error instanceof ProtocolError && error.certainty !== 'unknown';
    operation = store.markUnresolved(operation, knownRejected ? 'failed' : 'uncertain', safeProblem(error));
  }
  if (operation.items.some((item) => item.state === 'uncertain')) jobs.put(operation.id, operation.scope, 'reconcile', { operationId: operation.id });
  else jobs.remove(operation.id);
  return operation;
}
