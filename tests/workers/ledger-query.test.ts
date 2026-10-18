import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { TestClock } from '../support/upstream';
import { createActorContext } from '../../src/actor/context';
import { LedgerService } from '../../src/features/ledger/service';
import { FreshnessService } from '../../src/features/sync/freshness';
import { ResourceCache } from '../../src/storage/cache';
import { parseWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import { page } from '../support/fixtures';
import {bookListKey} from '../../src/features/books/source';
import {categoryKey} from '../../src/features/categories/source';
import {tagCatalogKey} from '../../src/features/tags/source';

it('uses authoritative option memberships while retaining old entities for historical bill names',async()=>{
 const s=await scenario();await s.run(async(ledger,ctx)=>{
  const cache=new ResourceCache(ctx.repository,s.clock),scope=s.app.scope;
  const apply=(key:import('../../src/storage/cache').CacheKey,items:import('../../src/storage/resources').ResourceRecord[],complete=true)=>cache.applyRead(cache.captureRead(scope,key),{items,complete});
  apply(bookListKey,[{id:'10',kind:'book',raw:{bookid:10,name:'current'}},{id:'11',kind:'book',raw:{bookid:11,name:'old book'}}]);
  apply(bookListKey,[{id:'10',kind:'book',raw:{bookid:10,name:'current'}}]);
  const key=categoryKey({bookId:'10',type:0});apply(key,[{id:'50',kind:'category',raw:{id:50,bookid:10,type:0,name:'old category'}}]);apply(key,[]);
  apply(categoryKey({bookId:'10',type:1}),[]);apply(tagCatalogKey,[]);
  expect(ledger.options()).toMatchObject({books:[{id:'10'}],categories:[],tags:[],complete:true});
  expect((await ctx.ledgerWrites.transferOptions()).books.map(book=>book.id)).toEqual(['10']);
  expect(ctx.repository.readResources(scope,'book',{domain:'books',ids:['11']}).items).toHaveLength(1);
  expect(ctx.repository.readResources(scope,'category',{domain:'ledger',ids:['50']}).items).toHaveLength(1);
  apply(key,[],false);expect(ledger.options().complete).toBe(false);
 });
});

const january = { kind: 'month' as const, year: 2026, month: 1 };
const time = (date: string) => Date.parse(`${date}T12:00:00+08:00`) / 1000;
function record(id: string, overrides: object = {}) {
  return projectBill(parseWire(JSON.stringify({ id, bookid: '10', type: 0, time: time('2026-01-10'), money: '10', userid: 'member-A', cateid: '50', assetid: 'asset-A', platform: 0, remark: '午餐', ...overrides })));
}
async function scenario() {
  const app = await createTestApp(), clock = new TestClock(time('2026-01-20') * 1000);
  async function run<T>(fn: (ledger: LedgerService, ctx: ReturnType<typeof createActorContext>) => T | Promise<T>): Promise<T> {
    return app.repository(async (repository) => {
      const context = createActorContext(repository.storage);
      const freshness = new FreshnessService({ repository, clock, sync: context.sync });
      const ledger = new LedgerService({ repository, clock, freshness, connection: context.connection });
      return fn(ledger, context);
    });
  }
  await run((_ledger, ctx) => {
    const repo = ctx.repository;
    repo.createDataset(app.scope, 'ledger', 'ledger');
    repo.applyPage(app.scope, 'ledger', page({ upserts: [], resources: [
      { id: '50', kind: 'category', raw: { id: '50', parentid: '-1', name: '餐饮' } },
      { id: '51', kind: 'category', raw: { id: '51', parentid: '50', name: '午餐' } },
    ], complete: true, validatedAt: clock.nowIso() }));
    repo.switchDataset(app.scope, 'ledger', 'ledger', parseWire('{"-1":100}'));
    new ResourceCache(repo, clock).confirmResources(app.scope, 'books', [
      { id: '10', kind: 'book', raw: { bookid: '10', name: '日常', visible: 1 } },
      { id: '11', kind: 'book', raw: { bookid: '11', name: '隐藏账本', visible: 0 } },
      { id: '12', kind: 'book', raw: { bookid: '12', name: '工作', visible: 1 } },
    ]);
  });
  return { app, clock, run };
}

describe('shared ledger queries', () => {
  it('combines parent category, member, tags, asset, source and literal remark filters while keeping IDs lossless', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [
        record('1792000000123100000', { cateid: '51', money: '0.10000000000000000001', platform: 2, remark: '午餐 100%_实付', extra: { tags: ['tag-A', 'tag-B'] } }),
        record('1792000000123100001', { bookid: '11', cateid: '51', platform: 2, extra: { tags: ['tag-A'] } }),
        record('1792000000123100002', { bookid: '12', cateid: '51', userid: 'member-B', platform: 2, extra: { tags: ['tag-A'] } }),
      ] }));
      const selected = await ledger.list({ date: january, categoryIds: ['50'], memberIds: ['member-A'], tagIds: ['tag-A', 'tag-B'], tagMatch: 'all', assetIds: ['asset-A'], sourcePlatforms: [2], remark: '100%_', amount: { min: '0.10000000000000000001', max: '0.10000000000000000001' } });
      expect(selected.items.map((item) => item.id)).toEqual(['1792000000123100000']);
      expect(selected.items[0]?.money).toBe('0.10000000000000000001');
      expect((await ledger.list({ date: january, bookIds: ['10', '12'] })).items).toHaveLength(2);
      expect((await ledger.list({ date: january, includeHiddenBooks: true })).items).toHaveLength(3);
      expect((await ledger.list({ date: january, categoryIds: ['50'], includeSubcategories: false })).items).toHaveLength(0);
    });
  });

  it('binds keyset pagination to account, dataset, normalized filter and data revision, including deletes', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [record('1792000000123100000'), record('1792000000123100001'), record('1792000000123100002')] }));
      const first = await ledger.list({ date: january, limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual(['1792000000123100002', '1792000000123100001']);
      expect((await ledger.list({ date: january, limit: 2, cursor: first.nextCursor! })).items.map((item) => item.id)).toEqual(['1792000000123100000']);
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [], deletes: ['1792000000123100000'] }));
      await expect(ledger.list({ date: january, limit: 2, cursor: first.nextCursor! })).rejects.toThrow('PAGE_CHANGED');
      const second = await ledger.list({ date: january, limit: 1 });
      ctx.repository.bindScope({ uid: 'other', connectionEpoch: 'other' });
      await expect(ledger.list({ date: january, limit: 1, cursor: second.nextCursor! })).rejects.toThrow('PAGE_CHANGED');
    });
  });

  it('loads cross-period related bills, respects modern refund precedence and flags missing children explicitly', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [
        record('100', { extra: { rfds: { '200': { money: '3' } }, refundid: '900', refundv: '8', bxs: { '300': { money: '4' }, '400': {} } } }),
        record('200', { type: 20, time: time('2026-02-10'), money: '3', extra: { refundsid: '100' } }),
        record('300', { type: 21, time: time('2026-03-10'), money: '4', extra: { bxsid: '100' } }),
      ] }));
      expect((await ledger.list({ date: january })).items.map((item) => item.id)).toEqual(['100']);
      const detail = await ledger.detail('100');
      expect(detail.refunds.map((item) => item.id)).toEqual(['200']);
      expect(detail.reimbursements.map((item) => item.id)).toEqual(['300']);
      expect(detail.missingRelatedIds).toEqual(['400']); expect(detail.freshness.complete).toBe(false);
      expect(detail.refundIds).toEqual(['200']);
      expect(JSON.stringify(detail)).not.toContain('"raw"');
    });
  });

  it('groups only adjacent type21 members with the same packId and keeps single-member rows and unknown types as real bills', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [
        record('101', { type: 21, packid: 'pack-A' }), record('102', { type: 21, packid: 'pack-A' }),
        record('103', { type: 21, packid: 'pack-B' }), record('104', { type: 999 }),
      ] }));
      const grouped = await ledger.list({ date: january });
      expect(grouped.items).toHaveLength(4); expect(grouped.rows).toHaveLength(3);
      const row = grouped.rows.find((item) => item.kind === 'reimbursement-group');
      expect(row && row.kind === 'reimbursement-group' ? row.memberIds : []).toEqual(['102', '101']);
      expect(grouped.rows.some((item) => item.kind === 'bill' && item.bill.id === '103')).toBe(true);
      expect(grouped.items.find((item) => item.id === '104')?.unknownType).toBe(true);
      expect((await ledger.list({ date: january, groupReimbursements: false })).rows).toHaveLength(4);
      expect(ctx.repository.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM bills').one().n).toBe(4);
    });
  });

  it('uses natural calendar months and the requested timezone without applying a custom book accounting start day', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      ctx.cache.confirmResources(s.app.scope, 'books', [{ id: '10', kind: 'book', raw: { bookid: '10', visible: 1, config: { range: 'm25' } } }]);
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [record('101', { time: time('2026-01-02') }), record('102', { time: time('2026-01-26') }), record('103', { time: time('2026-02-02') })] }));
      expect((await ledger.list({ date: january, bookIds: ['10'] })).items.map((item) => item.id)).toEqual(['103', '102']);
      const calendar = await ledger.calendar({ year: 2026, month: 1, filter: { bookIds: ['10'] } });
      expect(calendar.days.filter((day) => day.count > 0)).toEqual([{ date: '2026-01-02', count: 1 }, { date: '2026-01-26', count: 1 }]);
      expect(calendar.complete).toBe(true);
    });
  });
  it('compares numeric JSON member, tag and asset IDs as exact text and invalidates a cursor on book metadata changes', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      const raw = `{"id":1792000000123100000,"bookid":10,"type":0,"time":${time('2026-01-10')},"money":1,"userid":123456789012345678901,"assetid":9007199254740995,"extra":{"tags":[9007199254740997]}}`;
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [projectBill(parseWire(raw)), record('9'), record('10')] }));
      const selected = await ledger.list({ memberIds: ['123456789012345678901'], assetIds: ['9007199254740995'], tagIds: ['9007199254740997'] });
      expect(selected.items.map((item) => item.id)).toEqual(['1792000000123100000']);
      expect(selected.items[0]?.memberId).toBe('123456789012345678901');
      const ascending = await ledger.list({ limit: 1, order: 'asc' }); expect(ascending.items[0]?.id).toBe('9');
      ctx.cache.confirmResources(s.app.scope, 'books', [{ id: '10', kind: 'book', raw: { bookid: '10', name: '新账本名', visible: 1 } }]);
      await expect(ledger.list({ limit: 1, order: 'asc', cursor: ascending.nextCursor! })).rejects.toThrow('PAGE_CHANGED');
    });
  });
  it('buckets calendar days in the selected timezone and rejects invalid timezones with a stable error code', async () => {
    const s = await scenario();
    await s.run(async (ledger, ctx) => {
      ctx.repository.applyPage(s.app.scope, 'ledger', page({ upserts: [record('1', { time: Date.parse('2026-02-01T02:00:00Z') / 1000 })] }));
      const calendar = await ledger.calendar({ year: 2026, month: 1, filter: { zone: 'America/New_York' } });
      expect(calendar.days.find((day) => day.date === '2026-01-31')?.count).toBe(1);
      expect((await ledger.calendar({ year: 2026, month: 1 })).days.every((day) => day.count === 0)).toBe(true);
      await expect(ledger.list({ zone: 'Invalid/Zone' })).rejects.toThrow('INVALID_TIMEZONE');
    });
  });
});
