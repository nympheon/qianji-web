import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { TestClock, createUpstream } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import type { ActorScope } from '../../src/shared/model';
import type { MutationCommand, MutationHandler, OperationContext } from '../../src/operations/contract';
import { ProtocolError } from '../../src/protocol/errors';
import { commandDigest } from '../../src/operations/store';

async function scenario() {
  const app = await createTestApp();
  await app.repository((repo) => repo.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray());
  const clock = new TestClock(Date.now());
  const upstream = createUpstream(clock, app.scope);
  const counts = { send: 0, reconcile: 0, accepted: 0, maxSending: 0, sending: 0 };
  let loseReceipt = false;
  let hold: Promise<void> | null = null;
  let reconciled = false;
  let partial = false;
  let failReceipt = false;
  let reconcileWrite = false;
  const handler: MutationHandler = {
    prepare: async (command) => ({ payload: command.input, items: [{ id: 'item-1', affectedIds: ['bill-1'] }, ...(partial ? [{ id: 'item-2', affectedIds: ['bill-2'] }] : [])], affectedIds: partial ? ['bill-1', 'bill-2'] : ['bill-1'] }),
    send: async () => {
      counts.send++; counts.sending++; counts.maxSending = Math.max(counts.maxSending, counts.sending);
      try {
        if (hold) await hold;
        counts.accepted++;
        if (loseReceipt) throw new ProtocolError('QIANJI_NETWORK_ERROR', 'lost receipt', 'network', 'unknown');
        return { ec: '200', data: { accepted: 'item-1' }, httpStatus: 200 };
      } finally { counts.sending--; }
    },
    applyReceipt: (_prepared, _reply, ctx) => {
      if (failReceipt) {
        ctx.repository.saveDraft(app.scope, 'receipt-partial', { mustRollback: true });
        throw new Error('simulated interruption before committing the receipt');
      }
      return { items: [{ id: 'item-1', state: 'succeeded' }, ...(partial ? [{ id: 'item-2', state: 'uncertain' } as const] : [])], idMap: { 'local-1': 'bill-1' } };
    },
    reconcile: async (_operation, ctx) => {
      counts.reconcile++;
      if (hold) await hold;
      if (reconcileWrite) await ctx.client.request('account.logout', {}, app.scope);
      return { items: [{ id: 'item-1', state: reconciled ? 'succeeded' : 'uncertain' }, ...(partial ? [{ id: 'item-2', state: 'uncertain' } as const] : [])] };
    },
  };
  async function withCoordinator<T>(fn: (coordinator: Coordinator, ctx: OperationContext) => Promise<T> | T): Promise<T> {
    return app.repository(async (repository) => {
      const context = { repository, client: upstream.client, clock };
      return fn(new Coordinator(context, new Map([['test.write', handler]])), context);
    });
  }
  const command = (requestId = 'key-1', scope: ActorScope = app.scope): MutationCommand => ({ action: 'test.write', input: { amount: '0.1' }, scope, requestId });
  return { app, clock, counts, upstream, withCoordinator, command, setLoss: () => { loseReceipt = true; }, setPartial: () => { partial = true; }, setReconciled: () => { reconciled = true; }, failReceipt: () => { failReceipt = true; }, reconcileWrite: () => { reconcileWrite = true; }, hold(promise: Promise<void> | null) { hold = promise; } };
}

describe('durable mutation coordinator', () => {
  it('durably checkpoints an earlier receipt before a later batch loses its response', async () => {
    const app = await createTestApp();
    const clock = new TestClock(Date.now()), upstream = createUpstream(clock, app.scope);
    let sends = 0;
    await app.repository(async (repository) => {
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
      const handler: MutationHandler = {
        prepare: async () => ({ payload: {}, items: [{ id: 'a', affectedIds: ['a'] }, { id: 'b', affectedIds: ['b'] }], affectedIds: ['a', 'b'] }),
        send: async (prepared, ctx) => {
          sends++;
          ctx.checkpoint!(prepared, { items: [{ id: 'a', state: 'succeeded' }] });
          expect(ctx.currentOperation!().items.map((item) => item.state)).toEqual(['succeeded', 'sending']);
          throw new ProtocolError('QIANJI_NETWORK_ERROR', 'lost second batch', 'network', 'unknown');
        },
        applyReceipt: () => ({ items: [] }), reconcile: async () => ({ items: [] }),
      };
      const coordinator = new Coordinator({ repository, client: upstream.client, clock }, new Map([['test.batch', handler]]));
      const command: MutationCommand = { action: 'test.batch', input: {}, scope: app.scope, requestId: 'batch-checkpoint' };
      const result = await coordinator.submit(command);
      expect(result.state).toBe('partial');
      expect(result.items.map((item) => item.state)).toEqual(['succeeded', 'uncertain']);
      expect((await coordinator.submit(command)).id).toBe(result.id);
      expect(sends).toBe(1);
    });
  });

  it('rolls back canonical changes with a failed receipt checkpoint and keeps replacement IDs protected', async () => {
    const app = await createTestApp(), clock = new TestClock(Date.now()), upstream = createUpstream(clock, app.scope);
    await app.repository(async (repository) => {
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
      const handler: MutationHandler = {
        prepare: async () => ({ payload: {}, items: [{ id: 'old', affectedIds: ['old'] }], affectedIds: ['old'] }),
        send: async (prepared, ctx) => {
          const next = { ...prepared, items: [{ id: 'old', affectedIds: ['old', 'replacement'] }], affectedIds: ['old', 'replacement'] };
          ctx.checkpoint!(next, { items: [], idMap: { old: 'replacement' } });
          expect(ctx.currentOperation!().items[0]?.affectedIds).toContain('replacement');
          ctx.checkpoint!(next, () => {
            repository.saveDraft(app.scope, 'must-rollback', { changed: true });
            throw new Error('interrupted receipt transaction');
          });
          return { ec: '200', data: {}, httpStatus: 200 };
        },
        applyReceipt: () => ({ items: [] }), reconcile: async () => ({ items: [] }),
      };
      const coordinator = new Coordinator({ repository, client: upstream.client, clock }, new Map([['test.batch', handler]]));
      const result = await coordinator.submit({ action: 'test.batch', input: {}, requestId: 'atomic-checkpoint', scope: app.scope });
      expect(result.state).toBe('uncertain'); expect(result.idMap).toEqual({ old: 'replacement' });
      expect(repository.readDraft(app.scope, 'must-rollback')).toBeNull();
    });
  });

  it('returns a durable operation immediately when execution uses actor background work', async () => {
    const s = await scenario();
    let finish!: () => void;
    s.hold(new Promise<void>((resolve) => { finish = resolve; }));
    await s.withCoordinator(async (_old, ctx) => {
      const pending: Promise<unknown>[] = [];
      const handler: MutationHandler = {
        prepare: async () => ({ payload: {}, items: [{ id: 'a', affectedIds: ['a'] }], affectedIds: ['a'] }),
        send: async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { ec: '200', data: {}, httpStatus: 200 }; },
        applyReceipt: () => ({ items: [{ id: 'a', state: 'succeeded' }] }), reconcile: async () => ({ items: [] }),
      };
      const coordinator = new Coordinator(ctx, new Map([['test.write', handler]]), { background: (task) => pending.push(task) });
      const result = await coordinator.submit(s.command());
      expect(['queued', 'sending']).toContain(result.state);
      expect(pending).toHaveLength(1);
      for (let i = 0; i < 100 && coordinator.getOperation(s.app.scope, result.id)?.state !== 'sending'; i++) await new Promise((resolve) => setTimeout(resolve, 1));
      finish(); await Promise.all(pending);
      expect(coordinator.getOperation(s.app.scope, result.id)?.state).toBe('succeeded');
    });
  });
  it('deduplicates concurrent identical requests, rejects changed input, and persists ID mappings', async () => {
    const s = await scenario();
    await s.withCoordinator(async (coordinator) => {
      const results = await Promise.all([coordinator.submit(s.command()), coordinator.submit(s.command())]);
      expect(results[0]?.id).toBe(results[1]?.id);
      expect(results[0]?.state).toBe('succeeded');
      expect(results[0]?.idMap).toEqual({ 'local-1': 'bill-1' });
      await expect(coordinator.submit({ ...s.command(), input: { amount: '0.2' } })).rejects.toThrow('REQUEST_KEY_REUSED');
      expect(s.counts.send).toBe(1);
    });
    await s.app.restart();
    s.clock.advance(1001);
    await s.withCoordinator(async (coordinator) => {
      expect((await coordinator.submit(s.command())).state).toBe('succeeded');
      expect(s.counts.send).toBe(1);
    });
  });

  it('does not resend an accepted request after a lost receipt, eviction, alarm or reconciliation', async () => {
    const s = await scenario(); s.setLoss();
    const result = await s.withCoordinator((coordinator) => coordinator.submit(s.command()));
    expect(result.state).toBe('uncertain');
    await s.app.restart();
    await s.withCoordinator(async (coordinator) => {
      await coordinator.recover();
      s.clock.advance(1001);
      await coordinator.resumeJobs();
      expect(coordinator.getOperation(s.app.scope, result.id)?.state).toBe('uncertain');
      expect(s.counts.send).toBe(1);
      const before = s.counts.reconcile;
      await coordinator.resumeJobs();
      expect(s.counts.reconcile).toBe(before);
      s.setReconciled();
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded');
      expect(s.counts.send).toBe(1);
    });
  });

  it('keeps confirmed batch items while unknown items await reads, without sending the batch again', async () => {
    const s = await scenario(); s.setPartial();
    await s.withCoordinator(async (coordinator) => {
      const first = await coordinator.submit(s.command());
      expect(first.state).toBe('partial');
      expect(first.items.map((item) => item.state)).toEqual(['succeeded', 'uncertain']);
      const second = await coordinator.reconcileOperation(s.app.scope, first.id);
      expect(second.items.map((item) => item.state)).toEqual(['succeeded', 'uncertain']);
      await coordinator.resumeJobs();
      expect(s.counts.send).toBe(1);
    });
  });
  it('wakes a held queued intent after the conflicting unknown operation is definitively reconciled', async () => {
    const s = await scenario(); s.setLoss();
    await s.withCoordinator(async (coordinator) => {
      const first = await coordinator.submit(s.command('unknown'));
      const held = await coordinator.submit(s.command('held'));
      expect(held.state).toBe('queued'); expect(held.error?.code).toBe('TARGET_UNCERTAIN');
      s.setReconciled(); expect((await coordinator.reconcileOperation(s.app.scope, first.id)).state).toBe('succeeded');
      s.clock.advance(1001); await coordinator.resumeJobs();
      expect(s.counts.send).toBe(2);
      expect(coordinator.getOperation(s.app.scope, held.id)?.state).toBe('uncertain');
    });
  });
  it('repairs the restart gap between persisting reconciliation and waking an eligible held intent', async () => {
    const s = await scenario(); s.setLoss();
    await s.withCoordinator(async (coordinator) => {
      const first = await coordinator.submit(s.command('unknown-before-restart'));
      const held = await coordinator.submit(s.command('held-before-restart'));
      expect(held.error?.code).toBe('TARGET_UNCERTAIN');
      // A committed receipt survived, but the process stopped before scheduling the held intent.
      coordinator.store.apply(coordinator.store.get(s.app.scope, first.id)!, { items: [{ id: 'item-1', state: 'succeeded' }] });
    });
    await s.app.restart();
    await s.withCoordinator(async (coordinator) => { await coordinator.recover(); s.clock.advance(1001); await coordinator.resumeJobs(); });
    expect(s.counts.send).toBe(2);
  });

  it('serializes remote writes and connection changes while cached reads stay available', async () => {
    const s = await scenario();
    await s.withCoordinator(async (coordinator, ctx) => {
      let release!: () => void;
      s.hold(new Promise<void>((resolve) => { release = resolve; }));
      const first = coordinator.submit(s.command('key-1'));
      // Attach the rejection immediately while waiting for the send checkpoint.
      const completion = first.then((value) => ({ value }), (error: unknown) => ({ error }));
      for (let attempt = 0; attempt < 100 && s.counts.send === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
      if (s.counts.send === 0) {
        const stopped = await completion;
        if ('error' in stopped) throw stopped.error;
        throw new Error('send checkpoint was not reached');
      }
      const second = coordinator.submit(s.command('key-2'));
      let switched = false;
      const connection = coordinator.changeConnection(async () => { switched = true; });
      ctx.repository.saveDraft(s.app.scope, 'draft', { note: 'reads need no write lock' });
      expect(ctx.repository.readDraft(s.app.scope, 'draft')).toEqual({ note: 'reads need no write lock' });
      expect(switched).toBe(false);
      release(); s.hold(null);
      await Promise.all([first, second, connection]);
      expect(s.counts.send).toBe(2);
      expect(s.counts.maxSending).toBe(1);
      expect(switched).toBe(true);
    });
  });

  it('does not look up, reconcile or send old UID operations using the new account', async () => {
    const s = await scenario();
    const first = await s.withCoordinator((coordinator) => coordinator.submit(s.command()));
    const newScope = { uid: 'user-B', connectionEpoch: 'epoch-B' };
    await s.app.repository((repo) => repo.bindScope(newScope));
    await s.withCoordinator(async (coordinator) => {
      expect(coordinator.getOperation(newScope, first.id)).toBeNull();
      await expect(coordinator.reconcileOperation(s.app.scope, first.id)).rejects.toThrow('STALE_CONNECTION');
      const next = await coordinator.submit(s.command('key-1', newScope));
      expect(next.id).not.toBe(first.id);
      expect(s.counts.send).toBe(2);
    });
  });

  it('merges concurrent manual reconciliations and blocks a related mutation on an uncertain target', async () => {
    const s = await scenario(); s.setLoss();
    await s.withCoordinator(async (coordinator) => {
      const first = await coordinator.submit(s.command());
      const blocked = await coordinator.submit(s.command('blocked'));
      expect(blocked.state).toBe('queued');
      expect(blocked.error?.code).toBe('TARGET_UNCERTAIN');
      expect(s.counts.send).toBe(1);
      const results = await Promise.all([coordinator.reconcileOperation(s.app.scope, first.id), coordinator.reconcileOperation(s.app.scope, first.id)]);
      expect(results[0]?.id).toBe(results[1]?.id);
      expect(s.counts.reconcile).toBe(1);
    });
  });

  it('repairs work without an alarm after eviction, and never resends a persisted sending marker', async () => {
    const s = await scenario();
    const interrupted = await s.withCoordinator(async (coordinator, ctx) => {
      const command = s.command('interrupted');
      const queued = coordinator.store.create(command, commandDigest(command));
      const prepared = coordinator.store.prepare(queued, { payload: {}, items: [{ id: 'item-1', affectedIds: ['bill-1'] }], affectedIds: ['bill-1'] });
      coordinator.store.markSending(prepared);
      expect(await ctx.repository.storage.getAlarm()).toBeNull();
      return prepared.id;
    });
    await s.app.restart();
    await s.withCoordinator(async (coordinator, ctx) => {
      await coordinator.recover();
      expect(await ctx.repository.storage.getAlarm()).not.toBeNull();
      s.clock.advance(5000);
      await coordinator.resumeJobs();
      expect(coordinator.getOperation(s.app.scope, interrupted)?.state).toBe('uncertain');
      expect(s.counts.send).toBe(0);
      expect(s.counts.reconcile).toBe(1);
      expect(await ctx.repository.storage.getAlarm()).toBeNull();
    });
  });

  it('restores a queued accepted intent whose alarm was not arranged, without consulting bill status', async () => {
    const s = await scenario();
    const queued = await s.withCoordinator((coordinator) => coordinator.store.create(s.command(), commandDigest(s.command())).id);
    await s.app.restart();
    await s.withCoordinator(async (coordinator) => {
      await coordinator.recover(); s.clock.advance(1001);
      await coordinator.resumeJobs();
      expect(coordinator.getOperation(s.app.scope, queued)?.state).toBe('succeeded');
      await coordinator.resumeJobs();
      expect(s.counts.send).toBe(1);
    });
  });

  it('rolls back local receipt changes after upstream acceptance and preserves uncertainty', async () => {
    const s = await scenario(); s.failReceipt();
    await s.withCoordinator(async (coordinator, ctx) => {
      const result = await coordinator.submit(s.command());
      expect(s.counts.accepted).toBe(1);
      expect(result.state).toBe('uncertain');
      expect(ctx.repository.readDraft(s.app.scope, 'receipt-partial')).toBeNull();
      await coordinator.submit(s.command());
      expect(s.counts.send).toBe(1);
    });
  });

  it('retains the alarm for other durable jobs and removes it when all work finishes', async () => {
    const s = await scenario();
    await s.withCoordinator(async (coordinator, ctx) => {
      const due = s.clock.nowMs() + 10_000;
      await coordinator.jobs.persistWithWakeup(() => coordinator.jobs.put('future-sync', s.app.scope, 'sync', { page: 'p2' }, due));
      await coordinator.submit(s.command());
      expect(await ctx.repository.storage.getAlarm()).toBe(due);
      coordinator.jobs.remove('future-sync');
      await coordinator.jobs.refreshAlarm();
      expect(await ctx.repository.storage.getAlarm()).toBeNull();
    });
  });

  it('does not persist login credentials as operation input or prepared payload', async () => {
    const s = await scenario();
    await s.withCoordinator(async (coordinator, ctx) => {
      await expect(coordinator.submit({ ...s.command(), input: { utoken: 'MUST_NOT_PERSIST' } })).rejects.toThrow('CREDENTIAL_IN_OPERATION');
      expect(ctx.repository.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM operations').one().n).toBe(0);
      expect(s.counts.send).toBe(0);
    });
  });

  it('enforces read-only reconciliation even if a domain handler accidentally requests a mutation', async () => {
    const s = await scenario(); s.setLoss(); s.reconcileWrite();
    await s.withCoordinator(async (coordinator) => {
      const operation = await coordinator.submit(s.command());
      const checked = await coordinator.reconcileOperation(s.app.scope, operation.id);
      expect(checked.error?.code).toBe('READ_ONLY_PROTOCOL');
      expect(s.upstream.calls).toHaveLength(0);
      expect(s.counts.send).toBe(1);
    });
  });
  it('does not cancel a queued intent when its result is queried for reconciliation before sending', async () => {
    const s = await scenario();
    await s.withCoordinator(async (coordinator, ctx) => {
      const queued = await coordinator.jobs.persistWithWakeup(() => {
        const operation = coordinator.store.create(s.command(), commandDigest(s.command()));
        coordinator.jobs.put(operation.id, s.app.scope, 'mutation', { operationId: operation.id });
        return operation;
      });
      expect((await coordinator.reconcileOperation(s.app.scope, queued.id)).state).toBe('queued');
      expect(ctx.repository.sql.exec('SELECT id FROM jobs WHERE id=?', queued.id).toArray()).toHaveLength(1);
      expect(s.counts.send).toBe(0);
    });
  });
  it('allows an unrelated write past more than five held uncertain-target intents', async () => {
    const s = await scenario();
    await s.withCoordinator(async (coordinator, ctx) => {
      for (let index = 0; index < 6; index++) {
        const command = s.command(`held-${index}`);
        const operation = coordinator.store.create(command, commandDigest(command));
        coordinator.store.setError(operation, { code: 'TARGET_UNCERTAIN', message: 'held' });
      }
      let sent = 0;
      const other = new Coordinator(ctx, new Map([['test.other', {
        prepare: async () => ({ payload: {}, affectedIds: ['other'], items: [{ id: 'other', affectedIds: ['other'] }] }),
        send: async () => { sent++; return { ec: '200', data: {}, httpStatus: 200 }; },
        applyReceipt: () => ({ items: [{ id: 'other', state: 'succeeded' }] }), reconcile: async () => ({ items: [] }),
      }]]));
      const result = await other.submit({ ...s.command('unrelated'), action: 'test.other' });
      expect(result.state).toBe('succeeded'); expect(sent).toBe(1);
    });
  });
});
