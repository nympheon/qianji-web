import { DomainError } from './errors';
import type { BookPeriod, DateFilter, TimeRange } from './model';

interface LocalDate { year: number; month: number; day: number }

function utcDate({ year, month, day }: LocalDate): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function checkedDate(year: number, month: number, day: number): LocalDate {
  if (![year, month, day].every(Number.isSafeInteger) || year < 1 || year > 9999) {
    throw new DomainError('INVALID_DATE', '业务日期无效');
  }
  const date = { year, month, day };
  const utc = utcDate(date);
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() + 1 !== month || utc.getUTCDate() !== day) {
    throw new DomainError('INVALID_DATE', '业务日期无效');
  }
  return date;
}

function parseDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new DomainError('INVALID_DATE', '业务日期无效');
  return checkedDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function nextDay(value: LocalDate): LocalDate {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function formatter(zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-GB-u-ca-iso8601', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new DomainError('INVALID_TIMEZONE', '时间区域无效');
  }
}

function midnight(value: LocalDate, format: Intl.DateTimeFormat): number {
  const target = utcDate(value).getTime();
  let instant = target;
  for (let i = 0; i < 5; i++) {
    const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
    const observed = utcDate({ year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }).getTime()
      + Number(parts.hour) * 3_600_000 + Number(parts.minute) * 60_000 + Number(parts.second) * 1000;
    const next = instant + target - observed;
    if (next === instant) return instant / 1000;
    instant = next;
  }
  throw new DomainError('INVALID_DATE_BOUNDARY', '该时区的日期边界需核验');
}

export function businessRange(filter: DateFilter, book: BookPeriod, zone: string): TimeRange {
  const format = formatter(zone);
  let start: LocalDate;
  let endExclusive: LocalDate;
  switch (filter.kind) {
    case 'day':
      start = parseDate(filter.date);
      endExclusive = nextDay(start);
      break;
    case 'range':
      start = parseDate(filter.from);
      endExclusive = nextDay(parseDate(filter.to));
      break;
    case 'year':
      start = checkedDate(filter.year, 1, 1);
      endExclusive = { year: filter.year + 1, month: 1, day: 1 };
      break;
    case 'month': {
      if (!Number.isSafeInteger(book.monthStartDay) || book.monthStartDay < 1 || book.monthStartDay > 28) {
        throw new DomainError('UNVERIFIED_BOOK_PERIOD', '月底起始日规则尚需APK证据，不自动截断');
      }
      start = checkedDate(filter.year, filter.month, book.monthStartDay);
      endExclusive = {
        year: filter.month === 12 ? filter.year + 1 : filter.year,
        month: filter.month === 12 ? 1 : filter.month + 1,
        day: book.monthStartDay,
      };
      break;
    }
  }
  const startSec = midnight(start, format);
  const endSec = midnight(endExclusive, format) - 1;
  if (endSec < startSec) throw new DomainError('INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
  return { startSec, endSec, zone };
}
