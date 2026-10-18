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
  const sendContext: OperationContext = { ...context, currentOperation,
    checkpoint: (prepared, update) => { repository.transaction(() => store.checkpoint(currentOperation(), prepared, typeof update === 'function' ? update() : update)); },
  };
  try {
    const reply = await handler.send(operation.prepared!, sendContext);
    repository.assertScope(operation.scope);
    operation = currentOperation();
    operation = store.saveReceived(operation,reply);
    operation = repository.transaction(() => store.markReceiptApplied(store.apply(operation, handler.applyReceipt(operation.prepared!, reply, {...context,client:context.client.asReadOnly()}))));
  } catch (error) {
    operation = currentOperation();
    const knownRejected = error instanceof ProtocolError && error.certainty !== 'unknown';
    operation = store.markUnresolved(operation, knownRejected ? 'failed' : 'uncertain', safeProblem(error));
  }
  if (operation.items.some((item) => item.state === 'uncertain')) jobs.put(operation.id, operation.scope, 'reconcile', { operationId: operation.id });
  else jobs.remove(operation.id);
  return operation;
}
