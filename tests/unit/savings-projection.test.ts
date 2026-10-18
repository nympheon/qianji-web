import { expect, it } from 'vitest';
import { projectSavings, savingsRuleWire } from '../../src/features/savings/projection';
it('keeps planned rows separate from recorded transactions and follows Calendar.add month clamping', () => {
  const rule = { mode: 'fixedAmount' as const, amount: '100', period: 3, frequency: 'month' as const, startDate: '2026-01-31', time: '08:30', zone: 'Asia/Shanghai' };
  const view = projectSavings(rule); expect(view.rows.map((row) => row.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-28']); expect(view.totalAmount).toBe('300'); expect(view.rows[0]).not.toHaveProperty('transId'); expect(savingsRuleWire(rule)).toMatchObject({ mode: 'fixedAmount', period: 3, frequency: 'month' });
});
it('projects all seven native creation modes without inventing random deposits', () => {
  for (const [mode, expected] of [['fixedAmount12', '1200'], ['fixedAmount36', '3600']] as const) expect(projectSavings({ mode, amount: '100', startDate: '2026-01-01' }).totalAmount).toBe(expected);
  const daily = projectSavings({ mode: 'daily365', initialAmount: '1', increment: '1', startDate: '2026-01-01' }); expect(daily.totalAmount).toBe('66795'); expect(daily.complete).toBe(false);
  expect(projectSavings({ mode: 'weekly52', initialAmount: '1', increment: '1', startDate: '2026-01-01' }).totalAmount).toBe('1378');
  const reverse = projectSavings({ mode: 'reverseWeekly52', initialAmount: '2', increment: '1', startDate: '2026-01-01' }); expect(reverse.totalAmount).toBe('3'); expect(reverse.rows.slice(0, 3).map((row) => row.amount)).toEqual(['2', '1', '0']);
  expect(projectSavings({ mode: 'custom', total: '1000', startDate: '2026-01-01', endDate: null })).toMatchObject({ totalAmount: '1000', rows: [], complete: true });
  expect(() => projectSavings({ mode: 'random' } as never)).toThrow();
});
