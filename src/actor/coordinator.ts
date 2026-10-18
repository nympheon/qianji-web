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
  readonly #active = new Set<Id>();
  #resuming: Promise<void> | null = null;
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
    return this.executeQueued(command.scope, operation.id);
  }
  private executeQueued(scope: ActorScope, id: Id): Promise<OperationView> {
    return this.exclusive(async () => {
      try {
        const target = this.store.get(scope, id);
        if (!target) throw new DomainError('OPERATION_MISSING', '操作不存在');
        if (target.state !== 'queued') return operationView(target);
        const connected = this.context.repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
        if (!connected) {
          this.jobs.remove(id);
          return operationView(this.store.setError(target, { code: 'CONNECTION_REQUIRED', message: '已保留排队操作，重新登录后继续' }));
        }
        const barrier = this.context.repository.sql.exec('SELECT job_id FROM sync_barrier WHERE uid=? AND connection_epoch=?', scope.uid, scope.connectionEpoch).toArray()[0];
        if (target.state === 'queued' && barrier) {
          this.jobs.remove(target.id);
          return operationView(this.store.setError(target, { code: 'REBUILD_IN_PROGRESS', message: '全量重建期间已保存排队操作' }));
        }
        // Drain earlier accepted intents first. UUID sorting must never reorder same-ms writes.
        for (const operation of this.store.queued(scope).filter((operation) => operation.error?.code !== 'TARGET_UNCERTAIN' || operation.id === id).slice(0, 5)) {
          const handler = this.handlers.get(operation.action);
          if (!handler) { this.jobs.remove(operation.id); continue; }
          this.#active.add(operation.id);
          try { await runMutation(operation, handler, this.context, this.store, this.jobs); }
          finally { this.#active.delete(operation.id); }
          if (operation.id === id) break;
        }
        return operationView(this.store.get(scope, id)!);
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
    const pending = (async () => {
      const operation = this.store.get(scope, id);
      if (!operation) throw new DomainError('OPERATION_MISSING', '操作不存在');
      this.context.repository.assertScope(operation.scope);
      if (this.#active.has(id)) return operationView(operation);
      const handler = this.handlers.get(operation.action);
      if (!handler) throw new DomainError('ACTION_UNAVAILABLE', '该操作核查暂不可用');
      try { return operationView(await reconcileMutation(operation, handler, this.context, this.store, this.jobs)); }
      finally { await this.jobs.refreshAlarm(); }
    })();
    this.#reconciliations.set(key, pending);
    void pending.then(() => this.#reconciliations.delete(key), () => this.#reconciliations.delete(key));
    return pending;
  }
  async resumeJobs(): Promise<void> {
    if (this.#resuming) return this.#resuming;
    this.#resuming = (async () => {
      for (const job of this.jobs.listDue().slice(0, 5)) {
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
        if (job.kind === 'mutation' && operation.state === 'queued') await this.executeQueued(job.scope, operation.id);
        else await this.reconcileOperation(job.scope, operation.id);
      }
      await this.jobs.refreshAlarm();
    })();
    try { await this.#resuming; } finally { this.#resuming = null; }
  }
  changeConnection<T>(fn: () => Promise<T>): Promise<T> { return this.exclusive(fn); }
  registerJobHandler(kind: string, handler: (job: DurableJob) => Promise<void>): void {
    this.#jobHandlers.set(kind, handler);
  }
  beginRebuild(scope: ActorScope, id: Id, create: () => void): Promise<Id> {
    return this.exclusive(() => this.jobs.persistWithWakeup(() => {
      this.context.repository.assertScope(scope);
      const existing = this.context.repository.sql.exec<{ job_id: string }>('SELECT job_id FROM sync_barrier WHERE uid=? AND connection_epoch=?', scope.uid, scope.connectionEpoch).toArray()[0];
      if (existing) return existing.job_id;
      this.context.repository.sql.exec('INSERT INTO sync_barrier(uid,connection_epoch,job_id) VALUES (?,?,?)', scope.uid, scope.connectionEpoch, id).toArray();
      create(); return id;
    }));
  }
  endRebuild(scope: ActorScope, id: Id, publish: () => void): Promise<void> {
    return this.exclusive(() => this.jobs.persistWithWakeup(() => {
      this.context.repository.assertScope(scope);
      const owner = this.context.repository.sql.exec<{ job_id: string }>('SELECT job_id FROM sync_barrier WHERE uid=? AND connection_epoch=?', scope.uid, scope.connectionEpoch).toArray()[0];
      if (owner?.job_id !== id) throw new DomainError('REBUILD_SUPERSEDED', '重建任务已被其他连接取代');
      publish();
      this.context.repository.sql.exec('DELETE FROM sync_barrier WHERE uid=? AND job_id=?', scope.uid, id).toArray();
      for (const operation of this.store.queued(scope)) {
        if (operation.error?.code !== 'TARGET_UNCERTAIN') this.jobs.put(operation.id, scope, 'mutation', { operationId: operation.id });
      }
    }));
  }
  async recover(): Promise<void> {
    const row = this.context.repository.sql.exec<{ uid: string | null; connection_epoch: string | null; state: string }>('SELECT uid,connection_epoch,state FROM connection WHERE singleton=1').one();
    if (row.uid !== null && row.connection_epoch !== null) {
      const scope = { uid: row.uid, connectionEpoch: row.connection_epoch };
      for (const operation of this.store.interrupted(scope)) {
        this.context.repository.transaction(() => {
          this.store.markUnresolved(operation, 'uncertain', { code: 'OPERATION_INTERRUPTED', message: '执行已中断，只核查既有结果' });
          if (row.state === 'connected') this.jobs.put(operation.id, scope, 'reconcile', { operationId: operation.id });
          else this.jobs.remove(operation.id);
        });
      }
      for (const operation of this.store.queued(scope)) {
        if (row.state === 'connected' && operation.error?.code !== 'TARGET_UNCERTAIN') this.jobs.put(operation.id, scope, 'mutation', { operationId: operation.id });
        else this.jobs.remove(operation.id);
      }
    }
    await this.jobs.refreshAlarm();
  }
}
