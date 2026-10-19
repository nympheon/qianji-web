import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { TestClock } from '../support/upstream';
import { ResourceCache, type CacheKey } from '../../src/storage/cache';
import { page } from '../support/fixtures';
import { Coordinator } from '../../src/actor/coordinator';
import { createUpstream } from '../support/upstream';
import { ProtocolError } from '../../src/protocol/errors';

const all: CacheKey = { domain: 'assets', queryKey: 'all', resourceKind: 'asset' };
const asset = (name: string) => ({ id: 'asset-A', kind: 'asset' as const, raw: { name } });

describe('source metadata and canonical resource cache', () => {
  it('keeps active catalog membership unchanged when a staged rebuild deletes a resource and then fails',async()=>{
    const app=await createTestApp();await app.repository(repo=>{
      const cache=new ResourceCache(repo,new TestClock(0)),key:CacheKey={domain:'tags',queryKey:'catalog:all'},tag={id:'retained',kind:'tag' as const,raw:{id:'retained',name:'retained'}};
      cache.applyRead(cache.captureRead(app.scope,key),{items:[tag],complete:true});const active=repo.dataset(app.scope,'tags')!;
      repo.createDataset(app.scope,'tags','staged');repo.applyPage(app.scope,'staged',page({upserts:[],resources:[tag]}),'tags');
      repo.applyPage(app.scope,'staged',page({upserts:[],resources:[],resourceDeletes:[{id:tag.id,kind:'tag'}]}),'tags');
      expect(()=>repo.switchDataset(app.scope,'tags','staged',null)).toThrow('DATASET_INCOMPLETE');
      expect(repo.dataset(app.scope,'tags')?.id).toBe(active.id);expect(cache.read(app.scope,key)).toMatchObject({items:[tag],complete:true});
      repo.applyPage(app.scope,active.id,page({upserts:[],resources:[],resourceDeletes:[{id:tag.id,kind:'tag'}]}),'tags');
      expect(cache.read(app.scope,key).items).toEqual([]);
    });
  });
  it('keeps a complete empty result fresh for 60 seconds without sliding expiration on reads', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const clock = new TestClock(0), cache = new ResourceCache(repo, clock);
      expect(cache.read(app.scope, all).complete).toBe(false);
      cache.applyRead(cache.captureRead(app.scope, all), { items: [], complete: true });
      clock.advance(40_000); expect(cache.read(app.scope, all)).toMatchObject({ items: [], complete: true, stale: false, validatedAt: 0 });
      clock.advance(40_000); expect(cache.read(app.scope, all)).toMatchObject({ complete: true, stale: true, validatedAt: 0 });
    });
  });
  it('does not extend collection validation when a single resource receipt is confirmed', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const clock = new TestClock(0), cache = new ResourceCache(repo, clock);
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('before')], complete: true });
      clock.advance(50_000); cache.confirmResources(app.scope, 'assets', [asset('after')]);
      expect(cache.read(app.scope, all).items).toEqual([asset('after')]);
      clock.advance(15_000); expect(cache.read(app.scope, all)).toMatchObject({ stale: true, validatedAt: 0 });
    });
  });
  it('rejects a slow old read after a write receipt and after an explicit source invalidation', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const cache = new ResourceCache(repo, new TestClock(0));
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('initial')], complete: true });
      const old = cache.captureRead(app.scope, all);
      cache.confirmResources(app.scope, 'assets', [asset('confirmed new')]);
      expect(cache.applyRead(old, { items: [asset('slow old')], complete: true })).toBe('superseded');
      expect(cache.read(app.scope, all).items).toEqual([asset('confirmed new')]);
      const second = cache.captureRead(app.scope, all); cache.invalidateSource(app.scope, all);
      expect(cache.applyRead(second, { items: [asset('other old')], complete: true })).toBe('superseded');
      expect(cache.read(app.scope, all).stale).toBe(true);
    });
  });
  it('rejects delayed results after UID or dataset replacement', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const cache = new ResourceCache(repo, new TestClock(0));
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('initial')], complete: true });
      const old = cache.captureRead(app.scope, all);
      repo.createDataset(app.scope, 'assets', 'new');
      repo.applyPage(app.scope, 'new', page({ upserts: [], resources: [asset('replacement')], complete: true }), 'assets');
      repo.switchDataset(app.scope, 'assets', 'new', null);
      expect(cache.applyRead(old, { items: [], complete: true })).toBe('superseded');
      const switched = cache.captureRead(app.scope, all);
      repo.bindScope({ uid: 'other', connectionEpoch: 'other' });
      expect(cache.applyRead(switched, { items: [asset('old account')], complete: true })).toBe('superseded');
    });
  });
  it('shares canonical objects across list/detail, and an empty filtered list cannot erase another list', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const cache = new ResourceCache(repo, new TestClock(0));
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('same entity')], complete: true });
      const detail: CacheKey = { ...all, queryKey: 'detail:asset-A' };
      cache.applyRead(cache.captureRead(app.scope, detail), { items: [asset('detail confirmed')], complete: true });
      expect(cache.read(app.scope, all).items).toEqual([asset('detail confirmed')]);
      const empty: CacheKey = { ...all, queryKey: 'archived:true' };
      cache.applyRead(cache.captureRead(app.scope, empty), { items: [], complete: true });
      expect(cache.read(app.scope, empty)).toMatchObject({ items: [], complete: true, stale: false });
      expect(cache.read(app.scope, all).items).toEqual([asset('detail confirmed')]);
    });
  });
  it('only advances validation time on a no-change check and never treats a partial empty query as complete', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const clock = new TestClock(0), cache = new ResourceCache(repo, clock);
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('same')], complete: true });
      const before = cache.read(app.scope, all);
      clock.advance(80_000); cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('same')], complete: true });
      expect(cache.read(app.scope, all)).toMatchObject({ revision: before.revision, changedAt: before.changedAt, validatedAt: 80_000, stale: false });
      const partial: CacheKey = { ...all, queryKey: 'not-finished' };
      cache.applyRead(cache.captureRead(app.scope, partial), { items: [], complete: false });
      expect(cache.read(app.scope, partial)).toMatchObject({ complete: false, stale: true, validatedAt: null });
    });
  });
  it('cannot clear an uncertain mutation with a fresh-looking display read, and invalidates older reads before sending', async () => {
    const app = await createTestApp();
    await app.repository(async (repo) => {
      repo.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
      const clock = new TestClock(Date.now() + 3_600_000), cache = new ResourceCache(repo, clock);
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('before')], complete: true });
      const old = cache.captureRead(app.scope, all);
      const coordinator = new Coordinator({ repository: repo, client: createUpstream(clock, app.scope).client, clock }, new Map([['asset.test', {
        prepare: async () => ({ payload: {}, items: [{ id: 'item', affectedIds: ['asset-A'] }], affectedIds: ['asset-A'], affectedDomains: ['assets' as const] }),
        send: async () => { throw new ProtocolError('QIANJI_TIMEOUT', 'unknown', 'timeout', 'unknown'); },
        applyReceipt: () => ({ items: [] }), reconcile: async () => ({ items: [] }),
      }]]));
      expect((await coordinator.submit({ scope: app.scope, requestId: 'asset-write', action: 'asset.test', input: {} })).state).toBe('uncertain');
      expect(cache.applyRead(old, { items: [asset('old read')], complete: true })).toBe('superseded');
      cache.applyRead(cache.captureRead(app.scope, all), { items: [asset('current read')], complete: true });
      expect(cache.read(app.scope, all)).toMatchObject({ complete: false, stale: true });
    });
  });
});
