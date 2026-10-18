import type { ActorScope, Id } from '../shared/model';
import type { MutationCommand, MutationHandler, OperationContext, OperationView } from '../operations/contract';
import { DomainError } from '../shared/errors';
import { commandDigest, OperationStore, operationView } from '../operations/store';
import { runMutation } from '../operations/runner';
import { reconcileMutation } from '../operations/reconcile';
import { Jobs, type DurableJob } from './jobs';

export class Coordinator {
  readonly store: OperationStore;
  readonly jobs: Jobs;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #reconciliations = new Map<string, Promise<OperationView>>();
  readonly #jobHandlers = new Map<string, (job: DurableJob) => Promise<void>>();
  constructor(private readonly context: OperationContext, private readonly handlers: ReadonlyMap<string, MutationHandler>) {
    this.store = new OperationStore(context.repository, context.clock);
    this.jobs = new Jobs(context.repository, context.clock);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn); this.#tail = next.catch(() => undefined); return next;
  }
  async submit(command: MutationCommand): Promise<OperationView> {
    this.context.repository.assertScope(command.scope);
    if (!command.requestId || command.requestId.length > 200) throw new DomainError('REQUEST_KEY_REQUIRED', '写操作需要稳定的请求键');
    const handler = this.handlers.get(command.action);
    if (!handler) throw new DomainError('ACTION_UNAVAILABLE', '该写操作尚不可用');
    const digest = commandDigest(command);
    const existing = this.store.find(command.scope, command.requestId);
    if (existing && existing.digest !== digest) throw new DomainError('REQUEST_KEY_REUSED', '请求键已用于不同参数');
    if (existing && existing.state !== 'queued') return operationView(existing);
    const operation = await this.jobs.persistWithWakeup(() => {
      const operation = this.store.create(command, digest);
      if (operation.state === 'queued') this.jobs.put(operation.id, operation.scope, 'mutation', { operationId: operation.id });
      return operation;
    });
    return this.exclusive(async () => {
      try {
        const latest = this.store.get(command.scope, operation.id)!;
        return operationView(await runMutation(latest, handler, this.context, this.store, this.jobs));
      } finally { await this.jobs.refreshAlarm(); }
    });
  }
  getOperation(scope: ActorScope, id: Id): OperationView | null {
    const operation = this.store.get(scope, id); return operation ? operationView(operation) : null;
  }
  async reconcileOperation(scope: ActorScope, id: Id): Promise<OperationView> {
    this.context.repository.assertScope(scope);
    const key = JSON.stringify([scope.uid, scope.connectionEpoch, id]);
    const existing = this.#reconciliations.get(key);
    if (existing) return existing;
    const pending = this.exclusive(async () => {
      const operation = this.store.get(scope, id);
      if (!operation) throw new DomainError('OPERATION_MISSING', '操作不存在');
      this.context.repository.assertScope(operation.scope);
      const handler = this.handlers.get(operation.action);
      if (!handler) throw new DomainError('ACTION_UNAVAILABLE', '该操作核查暂不可用');
      try { return operationView(await reconcileMutation(operation, handler, this.context, this.store, this.jobs)); }
      finally { await this.jobs.refreshAlarm(); }
    });
    this.#reconciliations.set(key, pending);
    void pending.then(() => this.#reconciliations.delete(key), () => this.#reconciliations.delete(key));
    return pending;
  }
  resumeJobs(): Promise<void> {
    return this.exclusive(async () => {
      for (const job of this.jobs.listDue()) {
        try { this.context.repository.assertScope(job.scope); }
        catch { this.jobs.remove(job.id); continue; }
        if (job.kind !== 'mutation' && job.kind !== 'reconcile') {
          const handler = this.#jobHandlers.get(job.kind);
          if (handler) await handler(job);
          else this.jobs.remove(job.id);
          continue;
        }
        const operation = this.store.get(job.scope, job.id);
        const handler = operation && this.handlers.get(operation.action);
        if (!operation || !handler) { this.jobs.remove(job.id); continue; }
        if (job.kind === 'mutation' && operation.state === 'queued') await runMutation(operation, handler, this.context, this.store, this.jobs);
        else await reconcileMutation(operation, handler, this.context, this.store, this.jobs);
      }
      await this.jobs.refreshAlarm();
    });
  }
  changeConnection<T>(fn: () => Promise<T>): Promise<T> { return this.exclusive(fn); }
  registerJobHandler(kind: string, handler: (job: DurableJob) => Promise<void>): void {
    this.#jobHandlers.set(kind, handler);
  }
  async recover(): Promise<void> {
    const row = this.context.repository.sql.exec<{ uid: string | null; connection_epoch: string | null }>('SELECT uid,connection_epoch FROM connection WHERE singleton=1').one();
    if (row.uid !== null && row.connection_epoch !== null) {
      const scope = { uid: row.uid, connectionEpoch: row.connection_epoch };
      for (const operation of this.store.interrupted(scope)) {
        this.context.repository.transaction(() => {
          this.store.markUnresolved(operation, 'uncertain', { code: 'OPERATION_INTERRUPTED', message: '执行已中断，只核查既有结果' });
          this.jobs.put(operation.id, scope, 'reconcile', { operationId: operation.id });
        });
      }
      for (const operation of this.store.queued(scope)) {
        if (operation.error?.code !== 'TARGET_UNCERTAIN') this.jobs.put(operation.id, scope, 'mutation', { operationId: operation.id });
      }
    }
    await this.jobs.refreshAlarm();
  }
}
