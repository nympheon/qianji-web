import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { TestClock } from '../support/upstream';
import { createActorContext } from '../../src/actor/context';
import { LedgerService } from '../../src/features/ledger/service';
import { FreshnessService } from '../../src/features/sync/freshness';
import { ResourceCache } from '../../src/storage/cache';
import { projectBill } from '../../src/features/sync/incremental';
import { parseWire } from '../../src/shared/wire-json';
import { page } from '../support/fixtures';

const time = (date: string) => Date.parse(`${date}T12:00:00+08:00`) / 1000;
const month = (month: number) => ({ kind: 'month' as const, year: 2026, month });
function bill(id: string, date: string, rest: object = {}) { return projectBill(parseWire(JSON.stringify({ id, bookid: '10', type: 0, time: time(date), money: '100', cateid: '51', userid: 'member', assetid: 'asset', ...rest }))); }
async function setup(run: (args: { ledger: LedgerService; ctx: ReturnType<typeof createActorContext>; clock: TestClock; scope: Awaited<ReturnType<typeof createTestApp>>['scope'] }) => Promise<void>) {
  const app = await createTestApp();
  await app.repository(async (repository) => {
    const ctx = createActorContext(repository.storage), clock = new TestClock(time('2026-01-20') * 1000);
    repository.createDataset(app.scope, 'ledger', 'dataset');
    repository.applyPage(app.scope, 'dataset', page({ upserts: [], resources: [{ kind: 'category', id: '50', raw: { id: '50', parentid: '-1' } }, { kind: 'category', id: '51', raw: { id: '51', parentid: '50' } }], complete: true, validatedAt: clock.nowIso() }));
    repository.switchDataset(app.scope, 'ledger', 'dataset', null);
    new ResourceCache(repository, clock).confirmResources(app.scope, 'books', [{ kind: 'book', id: '10', raw: { bookid: '10', visible: 1 } }]);
    const ledger = new LedgerService({ repository, connection: ctx.connection, clock, freshness: new FreshnessService({ repository, clock, sync: ctx.sync }) });
    await run({ ledger, ctx, clock, scope: app.scope });
  });
}
describe('statistics from the canonical ledger', () => {
  it('loads cross-period children and separates refund/reimbursement slots from ordinary income', async () => setup(async ({ ledger, ctx, scope }) => {
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [bill('1', '2026-01-10', { extra: { rfds: { '2': '30' } } }), bill('2', '2026-02-05', { type: 20, money: '30', extra: { refundsid: '1' } }), bill('3', '2026-01-15', { type: 5 }), bill('4', '2026-02-06', { type: 21, packid: 'pack', money: '10' }), bill('5', '2026-02-06', { type: 21, packid: 'pack', money: '20' })] }));
    expect((await ledger.statistics({ currency: 'CNY', filter: { date: month(1) } })).totals).toMatchObject({ totalSpend: '70', notBxedValue: '100', totalIncome: '0', count: 2 });
    expect((await ledger.statistics({ currency: 'CNY', filter: { date: month(2) } })).totals).toMatchObject({ totalSpend: '0', totalIncome: '0', refundValue: '30', edBaoxiaoValue: '30', count: 3 });
  }));
  it('reuses computations across no-change validations and invalidates historical periods on a child change', async () => setup(async ({ ledger, ctx, scope, clock }) => {
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [bill('1', '2026-01-10', { extra: { rfds: { '2': '30' } } }), bill('2', '2026-02-05', { type: 20, money: '30' })] }));
    const input = { currency: 'CNY', filter: { date: month(1) } }, first = await ledger.statistics(input);
    clock.advance(61_000);
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [], validatedAt: clock.nowIso() }));
    expect((await ledger.statistics(input)).totals).toBe(first.totals);
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [bill('2', '2026-02-05', { type: 20, money: '40' })] }));
    expect((await ledger.statistics(input)).totals.totalSpend).toBe('60');
  }));
  it('changes relative-day and custom business-month keys even without source data changes', async () => setup(async ({ ledger, ctx, scope, clock }) => {
    clock.advance(Date.parse('2026-01-24T23:59:59+08:00') - clock.nowMs());
    new ResourceCache(ctx.repository, clock).confirmResources(scope, 'books', [{ kind: 'book', id: '10', raw: { bookid: '10', visible: 1, config: { range: 'm25' } } }]);
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [bill('1', '2026-01-24', { money: '10' }), bill('2', '2026-01-25', { money: '20' })] }));
    const today = { currency: 'CNY', filter: { date: { kind: 'today' as const } }, comparison: { kind: 'day' as const, date: '2026-01-24' } };
    const before = await ledger.statistics(today), monthBefore = await ledger.statistics({ currency: 'CNY', filter: { date: { kind: 'this-month' } } });
    clock.advance(2000);
    const after = await ledger.statistics(today), monthAfter = await ledger.statistics({ currency: 'CNY', filter: { date: { kind: 'this-month' } } });
    expect(before.totals.totalSpend).toBe('10'); expect(after.totals.totalSpend).toBe('20'); expect(after.comparison?.totals.totalSpend).toBe('10');
    expect(monthBefore.range?.endSec).not.toBe(monthAfter.range?.endSec); expect(monthAfter.totals.totalSpend).toBe('20');
  }));
  it('shares category hierarchy, overlapping tags, member/asset groups, trends and comparison accounting', async () => setup(async ({ ledger, ctx, scope }) => {
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [bill('1', '2026-01-10', { money: '10', extra: { tags: ['a', 'b'] } }), bill('2', '2026-01-11', { money: '20', extra: { tags: ['a'] } }), bill('3', '2025-12-10', { money: '8' })] }));
    const result = await ledger.statistics({ currency: 'CNY', filter: { date: month(1) }, dimensions: ['category-tree', 'tag', 'member', 'asset'], comparison: { kind: 'month', year: 2025, month: 12 } });
    expect(result.totals.totalSpend).toBe('30'); expect(result.trend.map((point) => point.totals.totalSpend)).toEqual(['10', '20']);
    expect(result.groups.find((group) => group.dimension === 'tag')).toMatchObject({ overlapping: true, items: [{ key: 'a', totals: { totalSpend: '30' } }, { key: 'b', totals: { totalSpend: '10' } }] });
    expect(result.groups.find((group) => group.dimension === 'category-tree')?.items.map((item) => [item.key, item.totals.totalSpend])).toEqual([['50', '30'], ['51', '30']]);
    expect(result.comparison?.totals.totalSpend).toBe('8');
    expect((await ledger.statistics({ currency: 'CNY', filter: { date: month(1) }, trend: 'month' })).trend[0]?.totals.totalSpend).toBe('30');
  }));
  it('marks incomplete source, missing related bills and currency gaps instead of certifying zero', async () => setup(async ({ ledger, ctx, scope }) => {
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [bill('1', '2026-01-10', { extra: { rfds: { '2': '30' } } })] }));
    const result = await ledger.statistics({ currency: 'EUR' });
    expect(result.freshness.complete).toBe(false); expect(result.incompleteReasons).toEqual(expect.arrayContaining(['RELATED_BILL_MISSING', 'CURRENCY_NOT_RECORDED']));
    ctx.repository.applyPage(scope, 'dataset', page({ upserts: [], complete: false }));
    expect((await ledger.statistics({ currency: 'CNY' })).incompleteReasons).toContain('SOURCE_INCOMPLETE');
    await expect(ledger.statistics({ currency: 'CNY', filter: { cursor: 'bad' } } as never)).rejects.toThrow('INVALID_STATISTICS_INPUT');
  }));
  it('marks bounded sparse scans as partial and never presents a truncated zero as a complete total', async () => setup(async ({ ledger, ctx, scope }) => {
    const raw = JSON.stringify({ bookid: '10', type: 0, time: time('2026-01-10'), money: '1' });
    ctx.repository.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<5001)
      INSERT INTO bills(uid,domain,dataset_id,id,book_id,type,time_sec,money,raw)
      SELECT ?,'ledger','dataset',CAST(id AS TEXT),'10',0,?,'1',json_set(?,'$.id',CAST(id AS TEXT)) FROM ids`, scope.uid, time('2026-01-10'), raw).toArray();
    const result = await ledger.statistics({ currency: 'CNY', filter: { amount: { min: '2' } } });
    expect(result.totals.totalSpend).toBe('0'); expect(result.incompleteReasons).toContain('STATISTICS_SCAN_LIMIT'); expect(result.freshness.complete).toBe(false);
  }));
});
