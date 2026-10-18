import { describe, expect, it } from 'vitest';
import { businessRange } from '../../src/shared/dates';

describe('accounting date boundaries', () => {
  it('uses the selected accounting month and its next start, in Shanghai', () => {
    const r = businessRange({ kind: 'month', year: 2026, month: 10 }, { monthStartDay: 25 }, 'Asia/Shanghai');
    expect(new Date(r.startSec * 1000).toISOString()).toBe('2026-10-24T16:00:00.000Z');
    expect(new Date(r.endSec * 1000).toISOString()).toBe('2026-11-24T15:59:59.000Z');
  });

  it('handles leap days and year boundaries without mutating the input', () => {
    const filter = { kind: 'day' as const, date: '2024-02-29' };
    const r = businessRange(filter, { monthStartDay: 1 }, 'Asia/Shanghai');
    expect(new Date(r.startSec * 1000).toISOString()).toBe('2024-02-28T16:00:00.000Z');
    expect(new Date(r.endSec * 1000).toISOString()).toBe('2024-02-29T15:59:59.000Z');
    expect(filter.date).toBe('2024-02-29');
    const year = businessRange({ kind: 'year', year: 2026 }, { monthStartDay: 1 }, 'Asia/Shanghai');
    expect(new Date(year.endSec * 1000).toISOString()).toBe('2026-12-31T15:59:59.000Z');
  });

  it('uses local calendar midnights across daylight saving changes', () => {
    const r = businessRange({ kind: 'day', date: '2026-03-08' }, { monthStartDay: 1 }, 'America/New_York');
    expect(new Date(r.startSec * 1000).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(r.endSec * 1000).toISOString()).toBe('2026-03-09T03:59:59.000Z');
    expect(r.endSec - r.startSec + 1).toBe(23 * 3600);
  });

  it('rejects invalid dates, ranges and unverified month-end policies', () => {
    expect(() => businessRange({ kind: 'day', date: '2026-02-29' }, { monthStartDay: 1 }, 'Asia/Shanghai')).toThrow('INVALID_DATE');
    expect(() => businessRange({ kind: 'range', from: '2026-10-02', to: '2026-10-01' }, { monthStartDay: 1 }, 'Asia/Shanghai')).toThrow('INVALID_DATE_RANGE');
    expect(() => businessRange({ kind: 'month', year: 2026, month: 2 }, { monthStartDay: 31 }, 'Asia/Shanghai')).toThrow('UNVERIFIED_BOOK_PERIOD');
    expect(() => businessRange({ kind: 'day', date: '2026-10-01' }, { monthStartDay: 1 }, 'Invalid/Zone')).toThrow('INVALID_TIMEZONE');
  });
});
