import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { createTestApp } from '../support/app';
import { createActorContext } from '../../src/actor/context';
import { TestClock, createUpstream } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { ResourceCache } from '../../src/storage/cache';
import { SyncService } from '../../src/features/sync/service';
import { FreshnessService } from '../../src/features/sync/freshness';
import { RebuildService } from '../../src/features/sync/rebuild';
import { parseWire } from '../../src/shared/wire-json';
import {ledgerOptionSources} from '../../src/features/ledger/options';
import { page, bill } from '../support/fixtures';
import type { MutationHandler } from '../../src/operations/contract';
import fixtures from '../../fixtures/apk-454/sync-pages.json';
import { ProtocolError } from '../../src/protocol/errors';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function scenario() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3_600_000);
  const upstream = createUpstream(clock, app.scope), sends: string[] = [];
  const handlers = new Map<string, MutationHandler>([['test.write', {
    prepare: async (command) => ({ payload: command.input, affectedIds: [command.requestId], affectedDomains: ['ledger'], items: [{ id: command.requestId, affectedIds: [command.requestId] }] }),
    send: async (prepared) => { sends.push(prepared.items[0]!.id); return { ec: '200', data: {}, httpStatus: 200 }; },
    applyReceipt: (prepared, _reply, ctx) => {
      const dataset = ctx.repository.dataset(app.scope, 'ledger')!;
      ctx.repository.applyPage(app.scope, dataset.id, page({ upserts: [bill({ id: prepared.items[0]!.id })] }));
      return { items: prepared.items.map((item) => ({ id: item.id, state: 'succeeded' })) };
    },
    reconcile: async () => ({ items: [] }),
  }]]);
  async function run<T>(fn: (ctx: { repository: ReturnType<typeof createActorContext>['repository']; coordinator: Coordinator; sync: SyncService; rebuild: RebuildService; freshness: FreshnessService; cache: ResourceCache }) => T | Promise<T>): Promise<T> {
    return app.repository(async (repository) => {
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
      const connection = createActorContext(repository.storage).connection;
      const coordinator = new Coordinator({ repository, clock, client: upstream.client }, handlers);
      const cache = new ResourceCache(repository, clock);
      const sync = new SyncService({ repository, clock, client: upstream.client, coordinator, connection, delay: async () => undefined });
      const rebuild = new RebuildService({ repository, clock, client: upstream.client, coordinator, connection, sync, cache });
      const freshness = new FreshnessService({ repository, clock, sync });
      return fn({ repository, coordinator, sync, rebuild, freshness, cache });
    });
  }
  return { app, clock, upstream, sends, handlers, run };
}

describe('on-use refresh and rebuild lifecycle', () => {
  it('refreshes tags before a ledger-only on-use request and publishes new tag membership',async()=>{
    const s=await scenario();s.upstream.respond(async()=>{if(s.upstream.calls.at(-1)!.url.endsWith('/tag/syncall')){const reply=JSON.parse(fixtures.tags[1]!);reply.data.update=[{id:'new-tag',name:'手机新增',status:1}];return Response.json(reply);}return new Response(fixtures.ledger[1]);});
    await s.run(async({freshness,cache,repository})=>{await freshness.ensureFresh(s.app.scope,['ledger'],'normal');expect(s.upstream.calls.map(call=>new URL(call.url).pathname)).toEqual(['/tag/syncall','/syncv2/pull']);expect(cache.read(s.app.scope,{domain:'tags',queryKey:'rows:all'}).complete).toBe(true);expect(ledgerOptionSources(repository,s.clock,s.app.scope).tags.map(item=>item.id)).toEqual(['new-tag']);});
  });
  it('keeps the ledger waiting for paginated tags across restart without sending ledger first',async()=>{
    const s=await scenario();let tagPages=0;s.upstream.respond(async()=>{if(s.upstream.calls.at(-1)!.url.endsWith('/tag/syncall')){tagPages++;const reply=JSON.parse(fixtures.tags[1]!);reply.data.hasmore=tagPages<5;return Response.json(reply);}return new Response(fixtures.ledger[1]);});
    const job=await s.run(async({freshness})=>(await freshness.ensureFresh(s.app.scope,['ledger'],'manual-incremental')).job!);expect(job.domain).toBe('ledger');expect(job.state).toBe('running');expect(s.upstream.calls.some(call=>call.url.endsWith('/syncv2/pull'))).toBe(false);await s.app.restart();
    await s.run(async({sync})=>{await sync.resume(job.id);expect(sync.getJob(s.app.scope,job.id)?.state).toBe('succeeded');});expect(s.upstream.calls.at(-1)!.url.endsWith('/syncv2/pull')).toBe(true);expect(tagPages).toBe(5);
  });
  it('runs tag children before ledger children in a multi-domain rebuild',async()=>{
    const s=await scenario();s.upstream.respond(async()=>new Response(s.upstream.calls.at(-1)!.url.endsWith('/tag/list')?fixtures.groups:s.upstream.calls.at(-1)!.url.endsWith('/tag/syncall')?fixtures.tags[1]:fixtures.ledger[1]));
    await s.run(async({rebuild})=>{const job=await rebuild.rebuild(s.app.scope,['ledger','tags']);await rebuild.resume(job.id);expect(s.upstream.calls[0]!.url.endsWith('/tag/syncall')).toBe(true);expect(rebuild.getJob(s.app.scope,job.id)?.state).toBe('succeeded');});
  });
  it('checks at 60 seconds, never slides the check on a read, and merges cold concurrent requests', async () => {
    const s = await scenario(); s.upstream.respond(async () => new Response(s.upstream.calls.at(-1)!.url.endsWith('/tag/syncall')?fixtures.tags[1]:fixtures.ledger[1]));
    await s.run(async ({ freshness }) => {
      const first = await Promise.all([freshness.ensureFresh(s.app.scope, ['ledger'], 'normal'), freshness.ensureFresh(s.app.scope, ['ledger'], 'normal')]);
      expect(first[0]?.job?.id).toBe(first[1]?.job?.id); expect(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))).toHaveLength(1);
      s.clock.advance(40_000); expect((await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal')).job).toBeNull();
      expect(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))).toHaveLength(1);
      s.clock.advance(40_000); expect((await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal')).freshness.stale).toBe(false);
      expect(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))).toHaveLength(2);
    });
  });
  it('preserves the five-second completed-sync cooldown for manual incremental refresh and does not clear its cursor', async () => {
    const s = await scenario(); s.upstream.respond(async () => new Response(s.upstream.calls.at(-1)!.url.endsWith('/tag/syncall')?fixtures.tags[1]:fixtures.ledger[1]));
    await s.run(async ({ freshness }) => {
      await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal');
      s.clock.advance(4000); expect((await freshness.ensureFresh(s.app.scope, ['ledger'], 'manual-incremental')).job).toBeNull();
      s.clock.advance(1001); await freshness.ensureFresh(s.app.scope, ['ledger'], 'manual-incremental');
      expect(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))).toHaveLength(2);
      expect(parseWire(new URLSearchParams(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))[1]?.body).get('lasttimes')!)).toEqual(parseWire('{"-1":201}'));
    });
  });
  it('does not let a single bill receipt at t50 postpone the collection check at t65', async () => {
    const s = await scenario(); s.upstream.respond(async () => new Response(s.upstream.calls.at(-1)!.url.endsWith('/tag/syncall')?fixtures.tags[1]:fixtures.ledger[1]));
    await s.run(async ({ freshness, coordinator }) => {
      await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal');
      s.clock.advance(50_000); expect((await coordinator.submit({ scope: s.app.scope, action: 'test.write', input: {}, requestId: 'write-at-50' })).state).toBe('succeeded');
      expect(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))).toHaveLength(1);
      s.clock.advance(15_000); await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal');
      expect(s.upstream.calls.filter(call=>call.url.endsWith('/syncv2/pull'))).toHaveLength(2);
    });
  });
  it('retains old data on an expired check failure, stops retries, and keeps its successful revision when no data changes', async () => {
    const s = await scenario(); s.upstream.respond(async () => new Response(fixtures.ledger[1]));
    await s.run(async ({ freshness, coordinator, repository }) => {
      const first = await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal');
      s.clock.advance(65_000); const unchanged = await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal');
      expect(unchanged.freshness.revision).toBe(first.freshness.revision);
      const before = repository.dataset(s.app.scope, 'ledger');
      s.clock.advance(65_000); s.upstream.respond(async () => { throw new Error('offline'); });
      const failed = await freshness.ensureFresh(s.app.scope, ['ledger'], 'normal');
      expect(failed.freshness.stale).toBe(true); expect(failed.job?.state).toBe('failed');
      expect(repository.dataset(s.app.scope, 'ledger')?.id).toBe(before?.id);
      const calls = s.upstream.calls.length; s.clock.advance(600_000); await coordinator.resumeJobs();
      expect(s.upstream.calls).toHaveLength(calls);
    });
  });
  it('holds writes queued before the first, middle and final rebuild pages until the new dataset is published', async () => {
    const s = await scenario();
    await s.run(async ({ repository, rebuild, coordinator }) => {
      repository.createDataset(s.app.scope, 'ledger', 'old');
      repository.applyPage(s.app.scope, 'old', page({ complete: true }));
      repository.switchDataset(s.app.scope, 'ledger', 'old', parseWire('{"-1":100}'));
      repository.saveDraft(s.app.scope, 'draft', { note: '保留' });
      const first = deferred<void>(), final = deferred<void>(), enteredFirst = deferred<void>(), enteredFinal = deferred<void>();
      let count = 0;
      s.upstream.respond(async () => {
        count++;
        if (count === 1) { enteredFirst.resolve(); await first.promise; }
        if (count === 3) { enteredFinal.resolve(); await final.promise; }
        return new Response(`{"ec":200,"data":{"bookid":-1,"pageoffset":${count},"pagesign":"s${count}","hasmore":${count === 3 ? 0 : 1},"count":0,"lasttimes":{"-1":200},"changes":[],"deletes":[],"categories":[]}}`);
      });
      const started = rebuild.rebuild(s.app.scope, ['ledger']);
      const observed = started.then((job) => ({ job }), (error: unknown) => ({ error }));
      await Promise.race([enteredFirst.promise, observed.then((result) => { if ('error' in result) throw result.error; })]);
      const write = (requestId: string) => coordinator.submit({ scope: s.app.scope, action: 'test.write', input: {}, requestId });
      expect((await write('first')).state).toBe('queued'); expect(s.sends).toEqual([]);
      first.resolve(); const job = await started;
      expect(job.state).toBe('running'); expect((await write('middle')).state).toBe('queued');
      const finish = rebuild.resume(job.id); await enteredFinal.promise;
      expect((await write('final')).state).toBe('queued'); expect(repository.dataset(s.app.scope, 'ledger')?.id).toBe('old');
      final.resolve(); await finish;
      await write('after-release');
      s.clock.advance(1001); await coordinator.resumeJobs();
      expect(s.sends).toEqual(['first', 'middle', 'final', 'after-release']);
      expect(repository.dataset(s.app.scope, 'ledger')?.id).not.toBe('old');
      for (const id of s.sends) expect(repository.readBill(s.app.scope, id)).not.toBeNull();
      expect(repository.readDraft(s.app.scope, 'draft')).toEqual({ note: '保留' });
      expect(count).toBe(3);
    });
  });
  it('leaves the original dataset and cursor intact when a rebuild fails', async () => {
    const s = await scenario();
    await s.run(async ({ repository, rebuild }) => {
      repository.createDataset(s.app.scope, 'ledger', 'old'); repository.applyPage(s.app.scope, 'old', page({ complete: true }));
      repository.switchDataset(s.app.scope, 'ledger', 'old', parseWire('{"-1":100}'));
      s.upstream.respond(async () => { throw new Error('offline'); });
      expect((await rebuild.rebuild(s.app.scope, ['ledger'])).state).toBe('failed');
      expect(repository.dataset(s.app.scope, 'ledger')?.id).toBe('old');
      expect(repository.syncState(s.app.scope, 'ledger', 'old')?.cursor).toEqual(parseWire('{"-1":100}'));
      expect(repository.readBill(s.app.scope, bill().id)).not.toBeNull();
      expect(repository.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM datasets WHERE uid=?', s.app.scope.uid).one().n).toBe(1);
    });
  });
  it('keeps only active or in-use datasets across repeated rebuilds while retaining operation history and drafts', async () => {
    const s = await scenario(); s.upstream.respond(async () => new Response(fixtures.ledger[1]));
    await s.run(async ({ rebuild, repository, coordinator }) => {
      repository.saveDraft(s.app.scope, 'draft', { value: 'preserve' });
      await rebuild.rebuild(s.app.scope, ['ledger']);
      await coordinator.submit({ scope: s.app.scope, action: 'test.write', input: {}, requestId: 'history' });
      await rebuild.rebuild(s.app.scope, ['ledger']);
      expect(repository.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM datasets WHERE uid=?', s.app.scope.uid).one().n).toBe(1);
      expect(repository.readDraft(s.app.scope, 'draft')).toEqual({ value: 'preserve' });
      expect(coordinator.store.find(s.app.scope, 'history')?.state).toBe('succeeded');
    });
  });

  it('rebuilds only tags from both real tag sources while preserving the ledger pointer', async () => {
    const s = await scenario();
    await s.run(async ({ repository, rebuild, cache }) => {
      for (const domain of ['ledger', 'tags'] as const) {
        repository.createDataset(s.app.scope, domain, `old-${domain}`);
        repository.applyPage(s.app.scope, `old-${domain}`, page({ upserts: [], complete: true }), domain);
        repository.switchDataset(s.app.scope, domain, `old-${domain}`, domain === 'tags' ? '100' : parseWire('{"-1":100}'));
      }
      s.upstream.respond(async () => new Response(s.upstream.calls.at(-1)?.url.endsWith('/tag/list') ? fixtures.groups : fixtures.tags[1]));
      const job = await rebuild.rebuild(s.app.scope, ['tags']);
      expect(job.state).toBe('succeeded'); expect(repository.dataset(s.app.scope, 'ledger')?.id).toBe('old-ledger');
      expect(repository.dataset(s.app.scope, 'tags')?.id).not.toBe('old-tags');
      expect(cache.read(s.app.scope, { domain: 'tags', queryKey: 'catalog:all' })).toMatchObject({ complete: true, stale: false });
      expect(repository.readResources(s.app.scope, 'tagGroup', { domain: 'tags' }).items.map((item) => item.id)).toEqual(['group-A']);
      expect(s.upstream.calls).toHaveLength(2);
    });
  });

  it('does not publish any selected domain if a later source in the cohort fails', async () => {
    const s = await scenario();
    await s.run(async ({ repository, rebuild }) => {
      for (const domain of ['ledger', 'tags'] as const) {
        repository.createDataset(s.app.scope, domain, domain);
        repository.applyPage(s.app.scope, domain, page({ upserts: [], complete: true }), domain);
        repository.switchDataset(s.app.scope, domain, domain, domain === 'tags' ? '100' : parseWire('{"-1":100}'));
      }
      s.upstream.respond(async () => {
        const url = s.upstream.calls.at(-1)?.url;
        if (url?.endsWith('/syncv2/pull')) return new Response(fixtures.ledger[1]);
        if (url?.endsWith('/tag/syncall')) return new Response(fixtures.tags[1]);
        throw new Error('catalog unavailable');
      });
      const job = await rebuild.rebuild(s.app.scope, ['ledger', 'tags']);
      expect(job.state).toBe('running'); expect(repository.dataset(s.app.scope, 'ledger')?.id).toBe('ledger');
      await rebuild.resume(job.id);
      expect(rebuild.getJob(s.app.scope, job.id)?.state).toBe('failed');
      expect(repository.dataset(s.app.scope, 'ledger')?.id).toBe('ledger'); expect(repository.dataset(s.app.scope, 'tags')?.id).toBe('tags');
    });
  });

  it('rejects an ordinary sync response that arrives after a confirmed local write', async () => {
    const s = await scenario();
    await s.run(async ({ repository, coordinator, sync }) => {
      repository.createDataset(s.app.scope, 'ledger', 'old'); repository.applyPage(s.app.scope, 'old', page({ upserts: [bill({ money: '1' })], complete: true }));
      repository.switchDataset(s.app.scope, 'ledger', 'old', parseWire('{"-1":100}'));
      const entered = deferred<void>(), release = deferred<void>();
      s.upstream.respond(async () => { entered.resolve(); await release.promise; return new Response(fixtures.ledger[0]!.replace('"money":0.1', '"money":0.01')); });
      const pulling = sync.start({ domain: 'ledger', mode: 'incremental' }); await entered.promise;
      await coordinator.submit({ scope: s.app.scope, action: 'test.write', input: {}, requestId: bill().id });
      release.resolve(); const job = await pulling;
      expect(job.state).toBe('failed'); expect(job.error?.code).toBe('SYNC_SUPERSEDED');
      expect(repository.readBill(s.app.scope, bill().id)?.money).toBe('0.1');
      expect(repository.syncState(s.app.scope, 'ledger', 'old')?.cursor).toEqual(parseWire('{"-1":100}'));
    });
  });

  it('allows read-only result reconciliation to request a rebuild without deadlocking the write gate', async () => {
    const s = await scenario();
    await s.run(async ({ coordinator, rebuild }) => {
      s.upstream.respond(async () => new Response(fixtures.ledger[1]));
      s.handlers.set('test.unknown', {
        prepare: async () => ({ payload: {}, affectedIds: ['unknown'], affectedDomains: ['ledger'], items: [{ id: 'unknown', affectedIds: ['unknown'] }] }),
        send: async () => { throw new ProtocolError('QIANJI_NETWORK_ERROR', 'unknown', 'network', 'unknown'); },
        applyReceipt: () => ({ items: [] }),
        reconcile: async () => { await rebuild.rebuild(s.app.scope, ['ledger']); return { items: [{ id: 'unknown', state: 'succeeded' }] }; },
      });
      const operation = await coordinator.submit({ scope: s.app.scope, action: 'test.unknown', input: {}, requestId: 'unknown' });
      expect(operation.state).toBe('uncertain');
      expect((await coordinator.reconcileOperation(s.app.scope, operation.id)).state).toBe('succeeded');
      expect(s.upstream.calls).toHaveLength(1);
    });
  });
  it('persists a waiting rebuild before the previous remote mutation finishes', async () => {
    const s = await scenario();
    await s.run(async ({ coordinator, rebuild, repository }) => {
      const entered = deferred<void>(), release = deferred<void>(); let writeFinished = false;
      s.handlers.set('test.hold', {
        prepare: async () => ({ payload: {}, affectedIds: ['held'], items: [{ id: 'held', affectedIds: ['held'] }] }),
        send: async () => { entered.resolve(); await release.promise; writeFinished = true; return { ec: '200', data: {}, httpStatus: 200 }; },
        applyReceipt: () => ({ items: [{ id: 'held', state: 'succeeded' }] }), reconcile: async () => ({ items: [] }),
      });
      s.upstream.respond(async () => { expect(writeFinished).toBe(true); return new Response(fixtures.ledger[1]); });
      const writing = coordinator.submit({ scope: s.app.scope, action: 'test.hold', input: {}, requestId: 'held' }); await entered.promise;
      const rebuilding = rebuild.rebuild(s.app.scope, ['ledger']);
      let pending: { id: string } | undefined;
      for (let attempt = 0; attempt < 50 && !pending; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        pending = repository.sql.exec<{ id: string }>("SELECT id FROM rebuild_jobs WHERE state='running'").toArray()[0];
      }
      const phase = pending ? rebuild.getJob(s.app.scope, pending.id)?.phase : null;
      release.resolve(); await Promise.all([writing, rebuilding]);
      expect(pending).toBeDefined(); expect(phase).toBe('waiting');
    });
  });

  it('continues the actual actor alarm after eviction and stops requesting when the rebuild finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 3_600_000);
    const app = await createTestApp(); let pulls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/account/login')) return new Response('{"ec":200,"data":{"user":{"id":"user-A"},"token":"NON_REAL_ALARM_TOKEN","books":[]}}');
      pulls++;
      return new Response(`{"ec":200,"data":{"bookid":-1,"pageoffset":${pulls},"pagesign":"p${pulls}","hasmore":${pulls === 3 ? 0 : 1},"count":0,"lasttimes":{"-1":100},"changes":[],"deletes":[],"categories":[]}}`);
    });
    await app.actor.login({ account: 'person@example.test', password: 'NON_REAL' });
    const job = await app.repository(async (repository) => {
      const context = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
      return context.rebuild.rebuild(app.scope, ['ledger']);
    });
    expect(job.state).toBe('running'); expect(pulls).toBe(2);
    await app.restart(); vi.setSystemTime(Date.now() + 2000);
    expect(await runDurableObjectAlarm(app.actor)).toBe(true);
    await app.repository((repository) => {
      const context = createActorContext(repository.storage);
      expect(context.rebuild.getJob(app.scope, job.id)?.state).toBe('succeeded');
      expect(repository.dataset(app.scope, 'ledger')?.complete).toBe(true);
    });
    expect(pulls).toBe(3);
    vi.setSystemTime(Date.now() + 600_000); expect(await runDurableObjectAlarm(app.actor)).toBe(false); expect(pulls).toBe(3);
  });
  it('cancels queued source work and its durable barrier on logout without resuming it after eviction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 3_600_000);
    const app = await createTestApp(); let pulls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/account/login')) return new Response('{"ec":200,"data":{"user":{"id":"user-A"},"token":"NON_REAL","books":[]}}');
      if (String(input).endsWith('/account/logout')) return new Response('{"ec":200,"data":null}');
      pulls++; return new Response(`{"ec":200,"data":{"bookid":-1,"pageoffset":${pulls},"pagesign":"p${pulls}","hasmore":1,"count":0,"lasttimes":{},"changes":[],"deletes":[],"categories":[]}}`);
    });
    await app.actor.login({ account: 'person@example.test', password: 'NON_REAL' });
    await app.repository(async (repository) => {
      const context = createActorContext(repository.storage, { QIANJI_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
      const pending = await context.rebuild.rebuild(app.scope, ['ledger']);
      expect(pending.state).toBe('running');
      await context.connection.logout();
      expect(context.rebuild.getJob(app.scope, pending.id)?.state).toBe('failed');
      expect(repository.sql.exec('SELECT * FROM sync_barrier').toArray()).toEqual([]);
    });
    await app.restart(); vi.setSystemTime(Date.now() + 600_000);
    expect(await runDurableObjectAlarm(app.actor)).toBe(false); expect(pulls).toBe(2);
  });
});
