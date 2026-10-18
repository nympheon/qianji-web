import { DomainError } from '../shared/errors';
import type { Problem } from '../shared/reply';
import { ProtocolError } from '../protocol/errors';
import type { Jobs } from '../actor/jobs';
import type { MutationHandler, OperationContext, StoredOperation } from './contract';
import type { OperationStore } from './store';

export function safeProblem(error: unknown): Problem {
  return error instanceof DomainError ? { code: error.code, message: error.message }
    : { code: 'OPERATION_INTERRUPTED', message: '操作结果需要核查' };
}
export async function runMutation(operation: StoredOperation, handler: MutationHandler, context: OperationContext, store: OperationStore, jobs: Jobs): Promise<StoredOperation> {
  const { repository } = context;
  if (operation.state !== 'queued' || operation.sendCount > 0) return operation;
  repository.assertScope(operation.scope);
  try {
    const prepared = await handler.prepare({ scope: operation.scope, requestId: operation.requestId, action: operation.action, input: operation.input }, context);
    repository.assertScope(operation.scope);
    operation = store.prepare(operation, prepared);
  } catch (error) {
    operation = store.markUnresolved(operation, 'failed', safeProblem(error));
    jobs.remove(operation.id); return operation;
  }
  if (store.conflict(operation)) {
    jobs.remove(operation.id);
    return store.setError(operation, { code: 'TARGET_UNCERTAIN', message: '相关操作结果尚未核清，已保留排队操作' });
  }
  // This durable marker is deliberately conservative, even if a crash occurs before fetch.
  operation = repository.transaction(() => store.markSending(operation));
  try {
    const reply = await handler.send(operation.prepared!, context);
    repository.assertScope(operation.scope);
    operation = repository.transaction(() => store.apply(operation, handler.applyReceipt(operation.prepared!, reply, context)));
  } catch (error) {
    const knownRejected = error instanceof ProtocolError && error.certainty !== 'unknown';
    operation = store.markUnresolved(operation, knownRejected ? 'failed' : 'uncertain', safeProblem(error));
  }
  if (operation.items.some((item) => item.state === 'uncertain')) jobs.put(operation.id, operation.scope, 'reconcile', { operationId: operation.id });
  else jobs.remove(operation.id);
  return operation;
}
