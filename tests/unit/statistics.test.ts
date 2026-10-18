import { describe, expect, it } from 'vitest';
import vectors from '../../fixtures/apk-454/statistics.json';
import { aggregate, toStatItem } from '../../src/features/ledger/statistics';
import { calculateBudget } from '../../src/features/budget/calculate';
import { projectBill } from '../../src/features/sync/incremental';
import { summarizeBill } from '../../src/features/ledger/model';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import type { BillDetail } from '../../src/features/ledger/contract';
import { businessRange } from '../../src/shared/dates';

const freshness = { revision: '1', complete: true, stale: false, syncedAt: '2026-01-01T00:00:00Z' };
function bill(raw: object) { return summarizeBill(projectBill(parseWire(JSON.stringify({ id: '1', bookid: '10', type: 0, time: 100, money: '0', ...raw })))); }
function detail(raw: object, refunds: object[] = [], reimbursements: object[] = []): BillDetail {
  return { ...bill(raw), refunds: refunds.map(bill), reimbursements: reimbursements.map(bill), sources: [], missingRelatedIds: [], incompleteReasons: [], freshness };
}
describe('APK accounting vectors', () => {
  it.each(vectors.cases)('$name', (vector) => {
    const item = toStatItem(detail(vector.bill, vector.refunds, vector.reimbursements), vector.mode === 'budget' ? 'budget' : 'statistics', vector.currency ?? 'CNY');
    expect({ ...item, ...aggregate([item]) }).toMatchObject(vector.expected);
  });
  it('uses independent exclusion flags and never counts a virtual display row as real income', () => {
    expect(aggregate([toStatItem(detail({ money: '100', extra: { flag: 1 } }), 'budget', 'CNY')]).totalSpend).toBe('100');
    expect(aggregate([toStatItem(detail({ money: '100', extra: { flag: 2 } }), 'statistics', 'CNY')]).totalSpend).toBe('100');
    expect(aggregate([toStatItem(detail({ type: 22, money: '100' }), 'statistics', 'CNY')])).toMatchObject({ totalSpend: '0', totalIncome: '0', incompleteReasons: ['UNKNOWN_BILL_TYPE'] });
  });
  it('preserves missing child and unsupported currency status and warns for legacy/overrefund anomalies', () => {
    const missing = detail({ money: '100', extra: { rfds: { '2': '30' } } });
    missing.missingRelatedIds = ['2']; missing.incompleteReasons = ['RELATED_BILL_MISSING'];
    expect(toStatItem(missing, 'statistics', 'CNY').incompleteReasons).toContain('RELATED_BILL_MISSING');
    expect(toStatItem(detail({ money: '8', extra: { curr: { ss: 'USD', sv: '1', bs: 'CNY', bv: '8' } } }), 'statistics', 'EUR').incompleteReasons).toContain('CURRENCY_NOT_RECORDED');
    expect(toStatItem(detail({ type: 5, money: '100', extra: { baoxiaoed: 1 } }), 'statistics', 'CNY').warnings).toContain('LEGACY_REIMBURSEMENT');
    expect(toStatItem(detail({ money: '100' }, [{ type: 20, money: '130' }]), 'statistics', 'CNY').warnings).toContain('REFUND_EXCEEDS_SOURCE');
  });
  it('normalizes finite upstream exponent money without changing preserved wire JSON', () => {
    const raw = parseWire('{"id":1,"bookid":10,"type":0,"time":100,"money":1.234e-7,"extra":{"transfee":-1e-8}}');
    const record = projectBill(raw), item = toStatItem({ ...detail({}), ...summarizeBill(record) }, 'statistics', 'CNY');
    expect(record.money).toBe('0.0000001234'); expect(item.coupon).toBe('0.00000001');
    expect(stringifyWire(record.raw)).toContain('1.234e-7');
    expect(() => bill({ money: '1e-101' })).toThrow('BILL_MONEY_UNSUPPORTED');
    expect(() => bill({ money: 'Infinity' })).toThrow('BILL_MONEY_UNSUPPORTED');
  });
  it('uses the configured base currency for legacy records and does not demand a new FX rate', () => {
    expect(toStatItem(detail({ money: '8' }), 'statistics', 'USD', 'USD')).toMatchObject({ spend: '8', incompleteReasons: [] });
    const source = detail({ money: '8', extra: { curr: { ss: 'USD', sv: '1', ts: 'CNY', tv: '8', bs: 'CNY', bv: '8' } } }, [{ type: 20, money: '3' }]);
    expect(toStatItem(source, 'statistics', 'CNY')).toMatchObject({ spend: '5', incompleteReasons: [] });
  });
  it('counts parent and child budget consumption without doubling the total and counts excluded records', () => {
    const result = calculateBudget({ currency: 'CNY', categories: [{ id: '50', parentId: null }, { id: '51', parentId: '50' }], budgets: [{ id: 'total', categoryId: null, limit: '1000' }, { id: 'parent', categoryId: '50', limit: '500' }, { id: 'child', categoryId: '51', limit: '200' }],
      bills: [detail({ cateid: '51', money: '100' }), detail({ cateid: '51', money: '40', extra: { flag: 2 } }), detail({ type: 2, money: '500', extra: { transfee: '3' } }), detail({ type: 1, money: '200' })],
      range: businessRange({ kind: 'month', year: 2026, month: 1 }, { monthStartDay: 25 }, 'Asia/Shanghai'), nowSec: Date.parse('2026-02-20T12:00:00+08:00') / 1000 });
    expect(result).toMatchObject({ used: '103', totalNotBudget: '40', remainingDays: 5 });
    expect(result.rows.map(({ id, used, count }) => ({ id, used, count }))).toEqual([{ id: 'total', used: '103', count: 0 }, { id: 'parent', used: '100', count: 2 }, { id: 'child', used: '100', count: 2 }]);
  });
});
