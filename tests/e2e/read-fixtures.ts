import type { Page } from '@playwright/test';
import { summarizeBill } from '../../src/features/ledger/model';
import { projectBill } from '../../src/features/sync/incremental';
import { parseWire } from '../../src/shared/wire-json';
import { aggregate, toStatItem } from '../../src/features/ledger/statistics';
export const freshness = { revision: 'ledger:dataset:1', complete: true, stale: false, syncedAt: '2026-01-20T04:00:00Z' };
export const connection = { state: 'connected', uid: 'test', connectionEpoch: 'test', route: 'main', user: { name: '测试用户', vipType: null, vipEndSec: null }, lastCheckedAt: freshness.syncedAt, problem: null, refreshAvailable: false, protocolVersion: '4.5.4' };
export const bill = summarizeBill(projectBill(parseWire('{"id":1792000000123100000,"bookid":10,"type":0,"time":1768881600,"money":"90","remark":"午餐","cateid":50,"extra":{"transfee":"-10"}}')));
export const detail = { ...bill, refunds: [], reimbursements: [], sources: [], missingRelatedIds: [], incompleteReasons: [], freshness };
export const summary = aggregate([toStatItem(detail, 'statistics', 'CNY')]);
export const ledger = { items: [bill], rows: [{ kind: 'bill', bill }], nextCursor: null, range: null, freshness, incompleteReasons: [], continuationReason: null };
export const statistics = { currency: 'CNY', range: null, totals: summary, groups: [], trend: [{ period: '2026-01-20', totals: summary }], comparison: null, freshness, incompleteReasons: [] };
export const ready = (data: unknown, fresh: unknown = null) => ({ status: 'ready', data, freshness: fresh });
export async function mockReadApp(page: Page, connected = true) {
  await page.clock.install({ time: new Date('2026-01-20T04:00:00Z') });
  await page.route('**/api/actions', async (route) => {
    const { action } = route.request().postDataJSON();
    const values: Record<string, unknown> = {
      'connection.status': ready(connected ? connection : { ...connection, state: 'disconnected', uid: null, user: null }),
      'connection.selectRoute': ready(connection), 'connection.check': ready(connection),
      'ledger.options': ready({ books: [{ id: '10', name: '日常账本', visible: true }], categories: [{ id: '50', name: '餐饮', parentId: null }], tags: [], complete: true }),
      'ledger.list': ready(ledger, freshness), 'ledger.detail': ready(detail, freshness), 'ledger.statistics': ready(statistics, freshness),
      'ledger.calendar': ready({ days: Array.from({ length: 31 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, count: i === 19 ? 1 : 0 })), nextCursor: null, complete: true, freshness, range: { startSec: 1767196800, endSec: 1769875199, zone: 'Asia/Shanghai' } }, freshness),
      'sync.start': ready({ id: 'sync1', state: 'succeeded', domain: 'ledger', mode: 'incremental', phase: 'complete', pages: 1, receivedRecords: 1, complete: true, error: null, coverage: 'ledger' }),
      'capabilities.list': ready([{ action: 'ledger.list', enabled: true, reason: null, kind: 'read', evidence: 'apk-static' }]),
    };
    await route.fulfill({ json: values[action] ?? ready(null) });
  });
}
