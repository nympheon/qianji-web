import { describe, expect, it } from 'vitest';
import fixtures from '../../fixtures/apk-454/sync-pages.json';
import { createTestApp } from '../support/app';
import { TestClock, createUpstream } from '../support/upstream';
import { createActorContext } from '../../src/actor/context';
import { SyncService } from '../../src/features/sync/service';
import { Coordinator } from '../../src/actor/coordinator';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import { page, bill } from '../support/fixtures';
import { parseTagGroups } from '../../src/features/sync/incremental';

async function scenario() {
  const app = await createTestApp();
  const clock = new TestClock(Date.now() + 3_600_000);
  const upstream = createUpstream(clock, app.scope);
  const delays: number[] = [];
  async function run<T>(fn: (sync: SyncService, ctx: ReturnType<typeof createActorContext>, coordinator: Coordinator) => Promise<T> | T): Promise<T> {
    return app.repository(async (repository) => {
      const context = createActorContext(repository.storage);
      repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
      const coordinator = new Coordinator({ repository, clock, client: upstream.client }, new Map());
      const sync = new SyncService({ repository, coordinator, clock, client: upstream.client, connection: context.connection, delay: async (ms) => { delays.push(ms); } });
      return fn(sync, context, coordinator);
    });
  }
  return { app, clock, upstream, run, delays };
}

describe('APK incremental page contracts', () => {
  it('uses fixed starting lasttimes with upstream bookid/offset/sign, atomically applies relations/categories/deletes and commits the final cursor', async () => {
    const s = await scenario();
    let response = 0;
    s.upstream.respond(async () => new Response(fixtures.ledger[response++]));
    await s.run(async (sync, ctx) => {
      const repo = ctx.repository;
      repo.createDataset(s.app.scope, 'ledger', 'existing');
      repo.applyPage(s.app.scope, 'existing', page({ upserts: [bill({ id: '1792000000123100002' })], complete: true }));
      repo.switchDataset(s.app.scope, 'ledger', 'existing', parseWire(fixtures.startCursor));
      const job = await sync.start({ domain: 'ledger', mode: 'incremental' });
      expect(job.state).toBe('succeeded'); expect(job.pages).toBe(2); expect(job.complete).toBe(true);
      const calls = s.upstream.calls.map((call) => new URLSearchParams(call.body));
      expect(parseWire(calls[0]!.get('lasttimes')!)).toEqual(parseWire(fixtures.startCursor));
      expect(parseWire(calls[1]!.get('lasttimes')!)).toEqual(parseWire(fixtures.startCursor));
      expect(calls[1]?.get('bookid')).toBe('10'); expect(calls[1]?.get('pageoffset')).toBe('9007199254740993'); expect(calls[1]?.get('pagesign')).toBe('next-sign');
      const record = repo.readBill(s.app.scope, '1792000000123100000')!;
      expect(record.money).toBe('0.1'); expect(stringifyWire(record.raw)).toContain('9007199254740993');
      expect(record.relations).toEqual([{ kind: 'refund', targetId: '1792000000123100001', raw: parseWire('{"future":7}') }]);
      expect(repo.readBill(s.app.scope, '1792000000123100002')).toBeNull();
      expect(repo.readResources(s.app.scope, 'category', { domain: 'ledger' }).items[0]?.id).toBe('50');
      expect(repo.syncState(s.app.scope, 'ledger', 'existing')!.cursor).toEqual(parseWire('{"-1":201,"10":200}'));
      expect(s.delays).toEqual([]);
    });
  });

  it('keeps applied pages and the old successful cursor when the next page fails, without retrying it', async () => {
    const s = await scenario(); let attempt = 0;
    s.upstream.respond(async () => { if (attempt++ === 0) return new Response(fixtures.ledger[0]); throw new Error('offline'); });
    await s.run(async (sync, ctx) => {
      ctx.repository.createDataset(s.app.scope, 'ledger', 'd1');
      ctx.repository.applyPage(s.app.scope, 'd1', page({ upserts: [], complete: true }));
      ctx.repository.switchDataset(s.app.scope, 'ledger', 'd1', parseWire(fixtures.startCursor));
      const job = await sync.start({ domain: 'ledger', mode: 'incremental' });
      expect(job.state).toBe('failed'); expect(job.complete).toBe(false); expect(job.pages).toBe(1);
      expect(ctx.repository.readBill(s.app.scope, '1792000000123100000')).not.toBeNull();
      expect(ctx.repository.dataset(s.app.scope, 'ledger')?.complete).toBe(false);
      expect(ctx.repository.syncState(s.app.scope, 'ledger', 'd1')!.cursor).toEqual(parseWire(fixtures.startCursor));
      expect(s.upstream.calls).toHaveLength(2);
    });
  });

  it('keeps tag milliseconds/page independent of ledger cursors and uses local completion time only after hasmore=false', async () => {
    const s = await scenario(); let response = 0;
    s.upstream.respond(async () => { s.clock.advance(100); return new Response(fixtures.tags[response++]); });
    await s.run(async (sync, ctx) => {
      const repo = ctx.repository;
      repo.createDataset(s.app.scope, 'tags', 't1');
      repo.applyPage(s.app.scope, 't1', page({ upserts: [], resources: [{ id: 'tag-old', kind: 'tag', raw: { name: 'old' } }], complete: true }), 'tags');
      repo.switchDataset(s.app.scope, 'tags', 't1', '1792000000000');
      const job = await sync.start({ domain: 'tags', mode: 'incremental' });
      expect(job.state).toBe('succeeded');
      const forms = s.upstream.calls.map((call) => new URLSearchParams(call.body));
      expect(forms.map((form) => form.get('lasttime'))).toEqual(['1792000000000', '1792000000000']);
      expect(forms.map((form) => form.get('page'))).toEqual(['0', '1']);
      expect(repo.syncState(s.app.scope, 'tags', 't1')?.cursor).toBe(String(s.clock.nowMs()));
      expect(repo.readResources(s.app.scope, 'tag', { domain: 'tags' }).items.map((item) => item.id)).toEqual(['tag-A']);
      expect(repo.dataset(s.app.scope, 'ledger')).toBeNull();
      expect(repo.readResources(s.app.scope, 'tagGroup', { domain: 'tags' }).items).toEqual([]);
    });
  });

  it('does not clear mirrors on unknown response shapes and tag failure does not undo successful ledger data', async () => {
    const s = await scenario();
    s.upstream.respond(async () => new Response(fixtures.ledger[1]));
    await s.run(async (sync, ctx) => {
      expect((await sync.start({ domain: 'ledger', mode: 'incremental' })).state).toBe('succeeded');
      const before = ctx.repository.dataset(s.app.scope, 'ledger');
      s.upstream.respond(async () => new Response('{"ec":200,"data":{"future_schema":[]}}'));
      const tags = await sync.start({ domain: 'tags', mode: 'incremental' });
      expect(tags.state).toBe('failed'); expect(tags.error?.code).toBe('SYNC_RESPONSE_INVALID');
      expect(ctx.repository.dataset(s.app.scope, 'ledger')).toEqual(before);
      expect(ctx.repository.dataset(s.app.scope, 'tags')).toBeNull();
      expect(s.upstream.calls).toHaveLength(2);
    });
  });

  it('uses the initial full-pull pacing while incrementally writing pages, and never uploads bill status candidates', async () => {
    const s = await scenario(); let response = 0;
    s.upstream.respond(async () => new Response(fixtures.ledger[response++]));
    await s.run(async (sync, ctx) => {
      const job = await sync.start({ domain: 'ledger', mode: 'incremental' });
      expect(job.state).toBe('succeeded'); expect(s.delays).toHaveLength(1);
      expect(s.delays[0]).toBeGreaterThanOrEqual(150); expect(s.delays[0]).toBeLessThanOrEqual(220);
      expect(new URLSearchParams(s.upstream.calls[0]?.body).has('lasttimes')).toBe(false);
      expect(s.upstream.calls.every((call) => call.url.endsWith('/syncv2/pull'))).toBe(true);
      expect(ctx.repository.sql.exec('SELECT * FROM operations').toArray()).toEqual([]);
    });
  });

  it('loads grouped tag/list data as its own source, including ungrouped tags, without inventing syncall group fields', async () => {
    const s = await scenario();
    s.upstream.respond(async () => new Response(fixtures.groups));
    const reply = await s.upstream.client.asReadOnly().request('tag.list', { uid: s.app.scope.uid, status: '-1', lasttime: '0' }, s.app.scope);
    const resources = parseTagGroups(reply.data);
    expect(resources.map((item) => `${item.kind}:${item.id}`)).toEqual(['tagGroup:group-A', 'tag:tag-A']);
    expect(s.upstream.calls).toHaveLength(1);
    expect(new URLSearchParams(s.upstream.calls[0]?.body).get('status')).toBe('-1');
  });

  it.each([['ledger', 200], ['tags', 40]] as const)('retains the %s page limit across chunks, never marks a truncated source complete, and stops waking', async (domain, limit) => {
    const s = await scenario(); let fetched = 0;
    s.upstream.respond(async () => {
      fetched++;
      return new Response(domain === 'ledger'
        ? `{"ec":200,"data":{"bookid":-1,"pageoffset":${fetched},"pagesign":"p${fetched}","hasmore":1,"count":0,"lasttimes":{},"changes":[],"categories":[],"deletes":[]}}`
        : fixtures.tags[0]);
    });
    await s.run(async (sync, ctx, coordinator) => {
      ctx.repository.createDataset(s.app.scope, domain, 'bounded');
      ctx.repository.applyPage(s.app.scope, 'bounded', page({ upserts: [], complete: true }), domain);
      const cursor = domain === 'ledger' ? parseWire('{"-1":100}') : '100';
      ctx.repository.switchDataset(s.app.scope, domain, 'bounded', cursor);
      const job = await sync.start({ domain, mode: 'incremental' });
      for (let chunk = 0; chunk <= limit / 2; chunk++) { s.clock.advance(1001); await coordinator.resumeJobs(); }
      expect(sync.getJob(s.app.scope, job.id)?.state).toBe('truncated');
      expect(sync.getJob(s.app.scope, job.id)?.pages).toBe(limit);
      expect(ctx.repository.syncState(s.app.scope, domain, 'bounded')?.cursor).toEqual(cursor);
      expect(ctx.repository.dataset(s.app.scope, domain)?.complete).toBe(false);
      expect(fetched).toBe(limit);
      s.clock.advance(600_000); await coordinator.resumeJobs(); expect(fetched).toBe(limit);
    });
  });

  it('rejects a repeated continuation token and retains an explicit failure for an invalid persisted checkpoint', async () => {
    const s = await scenario();
    s.upstream.respond(async () => new Response(fixtures.ledger[0]));
    await s.run(async (sync) => {
      const repeated = await sync.start({ domain: 'ledger', mode: 'incremental' });
      expect(repeated.state).toBe('failed'); expect(repeated.error?.code).toBe('SYNC_RESPONSE_INVALID');
      expect(s.upstream.calls).toHaveLength(2);
    });
    s.upstream.respond(async () => new Response(fixtures.tags[0]));
    await s.run(async (sync, ctx) => {
      const queued = await sync.start({ domain: 'tags', mode: 'incremental' });
      ctx.repository.sql.exec('UPDATE sync_jobs SET checkpoint=? WHERE id=?', '{"unexpected":true}', queued.id).toArray();
      await sync.resume(queued.id);
      expect(sync.getJob(s.app.scope, queued.id)?.state).toBe('failed');
      expect(sync.getJob(s.app.scope, queued.id)?.error?.code).toBe('SYNC_RESPONSE_INVALID');
    });
  });
});
