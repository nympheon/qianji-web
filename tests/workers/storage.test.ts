import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { bill, page } from '../support/fixtures';
import { stringifyWire } from '../../src/shared/wire-json';
import { migrate } from '../../src/storage/migrations';

describe('SQLite mirrors', () => {
  it('keeps identical bill IDs separate across accounts and dataset switches', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      const a = app.scope, b = { uid: 'user-B', connectionEpoch: 'epoch-B' };
      repo.createDataset(a, 'ledger', 'a1');
      repo.applyPage(a, 'a1', page({ complete: true }));
      repo.switchDataset(a, 'ledger', 'a1', 'cursor-a');
      repo.saveDraft(a, 'draft-1', { text: '保留草稿' });
      repo.createDataset(a, 'ledger', 'a2');
      repo.applyPage(a, 'a2', page({ upserts: [bill({ money: '0.2' })], complete: true }));
      expect(repo.readBill(a, bill().id)?.money).toBe('0.1');
      repo.switchDataset(a, 'ledger', 'a2', 'cursor-new');
      expect(repo.readBill(a, bill().id)?.money).toBe('0.2');
      expect(repo.readDraft(a, 'draft-1')).toEqual({ text: '保留草稿' });
      repo.bindScope(b);
      expect(() => repo.readBill(a, bill().id)).toThrow('STALE_CONNECTION');
      repo.createDataset(b, 'ledger', 'a2');
      repo.applyPage(b, 'a2', page({ upserts: [bill({ money: '9.99' })], complete: true }));
      repo.switchDataset(b, 'ledger', 'a2', null);
      expect(repo.readBill(b, bill().id)?.money).toBe('9.99');
      repo.bindScope(a);
      expect(repo.readBill(a, bill().id)?.money).toBe('0.2');
    });
    await app.restart();
    expect(await app.repository((repo) => repo.readBill(app.scope, bill().id)?.money)).toBe('0.2');
  });

  it('replays a page without duplicating rows or advancing its data revision', async () => {
    const app = await createTestApp();
    await app.repository((repo, storage) => {
      repo.createDataset(app.scope, 'ledger', 'd1');
      repo.applyPage(app.scope, 'd1', page({ complete: true }));
      repo.switchDataset(app.scope, 'ledger', 'd1', 'first');
      const revision = repo.dataset(app.scope, 'ledger')?.revision;
      repo.applyPage(app.scope, 'd1', page({ pageState: { next: 'p3' }, complete: true, validatedAt: '2026-10-18T00:01:00Z' }));
      expect(repo.dataset(app.scope, 'ledger')?.revision).toBe(revision);
      expect(storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM bills').one().n).toBe(1);
      expect(repo.syncState(app.scope, 'ledger', 'd1')?.cursor).toBe('first');
      expect(repo.syncState(app.scope, 'ledger', 'd1')?.pageState).toEqual({ next: 'p3' });
      const result = repo.readBill(app.scope, bill().id)!;
      expect(stringifyWire(result.raw)).toBe(stringifyWire(bill().raw));
      expect(result.relations).toEqual(bill().relations);
    });
  });

  it('rolls back rows, relations, revision and page progress on a mid-page failure', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      repo.createDataset(app.scope, 'ledger', 'd1');
      repo.applyPage(app.scope, 'd1', page({ complete: true }));
      repo.switchDataset(app.scope, 'ledger', 'd1', 'ok');
      const before = repo.dataset(app.scope, 'ledger');
      expect(() => repo.applyPage(app.scope, 'd1', page({
        upserts: [bill({ money: '7', relations: [] }), bill({ id: 'second', money: 'broken' })],
        pageState: { next: 'bad' }, cursor: 'must-not-save',
      }))).toThrow();
      expect(repo.readBill(app.scope, bill().id)).toEqual(bill());
      expect(repo.readBill(app.scope, 'second')).toBeNull();
      expect(repo.dataset(app.scope, 'ledger')).toEqual(before);
      expect(repo.syncState(app.scope, 'ledger', 'd1')?.cursor).toBe('ok');
      expect(stringifyWire(repo.syncState(app.scope, 'ledger', 'd1')!.pageState)).toBe('{"next":"p2"}');
    });
  });

  it('switches only a complete selected domain and deletes business IDs with their relations', async () => {
    const app = await createTestApp();
    await app.repository((repo, storage) => {
      for (const [domain, id] of [['ledger', 'l1'], ['tags', 't1']] as const) {
        repo.createDataset(app.scope, domain, id);
        repo.applyPage(app.scope, id, page({ upserts: [], complete: true }), domain);
        repo.switchDataset(app.scope, domain, id, domain);
      }
      repo.applyPage(app.scope, 'l1', page());
      repo.createDataset(app.scope, 'ledger', 'incomplete');
      expect(() => repo.switchDataset(app.scope, 'ledger', 'incomplete', null)).toThrow('DATASET_INCOMPLETE');
      repo.createDataset(app.scope, 'ledger', 'l2');
      repo.applyPage(app.scope, 'l2', page({ complete: true }));
      repo.switchDataset(app.scope, 'ledger', 'l2', 'new');
      expect(repo.dataset(app.scope, 'tags')?.id).toBe('t1');
      repo.applyPage(app.scope, 'l2', page({ upserts: [], deletes: [bill().id] }));
      expect(repo.readBill(app.scope, bill().id)).toBeNull();
      expect(storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM bill_relations WHERE dataset_id = ?', 'l2').one().n).toBe(0);
    });
  });

  it('shares resource entities, preserves a complete empty page and rejects changed page cursors', async () => {
    const app = await createTestApp();
    await app.repository((repo) => {
      repo.createDataset(app.scope, 'tags', 't1');
      const resources = ['a', 'b', 'c'].map((id) => ({ id, kind: 'tag' as const, raw: { name: id } }));
      repo.applyPage(app.scope, 't1', page({ upserts: [], resources, complete: true }), 'tags');
      repo.switchDataset(app.scope, 'tags', 't1', null);
      const first = repo.readResources(app.scope, 'tag', { domain: 'tags', limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual(['a', 'b']);
      expect(first.nextCursor).not.toBeNull();
      expect(repo.readResources(app.scope, 'tag', { domain: 'tags', limit: 2, cursor: first.nextCursor! }).items.map((item) => item.id)).toEqual(['c']);
      expect(repo.readResources(app.scope, 'tag', { domain: 'tags', ids: [] }).items).toEqual([]);
      expect(repo.readResources(app.scope, 'tag', { domain: 'tags', ids: ['b'] }).items).toEqual([resources[1]]);
      repo.applyPage(app.scope, 't1', page({ upserts: [], resources: [{ id: 'b', kind: 'tag', raw: { name: 'changed' } }] }), 'tags');
      expect(() => repo.readResources(app.scope, 'tag', { domain: 'tags', limit: 2, cursor: first.nextCursor! })).toThrow('PAGE_CHANGED');
    });
  });

  it('runs migrations idempotently and rolls back a failed schema step', async () => {
    const app = await createTestApp();
    await app.repository((_repo, storage) => {
      migrate(storage); migrate(storage);
      expect(storage.sql.exec<{ version: number }>('SELECT MAX(version) AS version FROM schema_version').one().version).toBe(2);
      expect(() => migrate(storage, [{ version: 3, name: 'broken', sql: 'CREATE TABLE test_broken (id TEXT); INVALID SQL;' }])).toThrow();
      expect(storage.sql.exec('SELECT name FROM sqlite_master WHERE name = ?', 'test_broken').toArray()).toEqual([]);
      expect(storage.sql.exec<{ version: number }>('SELECT MAX(version) AS version FROM schema_version').one().version).toBe(2);
    });
  });

  it('rejects asynchronous SQLite transactions and late scopes after an epoch change', async () => {
    const app = await createTestApp();
    await app.repository((repo, storage) => {
      expect(() => repo.transaction(() => {
        storage.sql.exec("INSERT INTO drafts(uid,id,raw) VALUES('user-A','async','null')");
        return Promise.resolve();
      })).toThrow('ASYNC_TRANSACTION');
      expect(repo.readDraft(app.scope, 'async')).toBeNull();
      repo.bindScope({ ...app.scope, connectionEpoch: 'new-epoch' });
      expect(() => repo.saveDraft(app.scope, 'late', null)).toThrow('STALE_CONNECTION');
    });
  });
});
