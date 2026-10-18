import { DomainError } from './errors';
/** Reject DST folds/gaps instead of silently selecting a different bill time. */
export function businessTimeSec(date: string, time: string, zone: string) {
  let format: Intl.DateTimeFormat; try { format = new Intl.DateTimeFormat('en-GB-u-ca-iso8601', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch { throw new DomainError('INVALID_TIMEZONE', '业务时区无效'); }
  const target = Date.parse(`${date}T${time}:00Z`), observed = (ms: number) => { const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value])); return Date.parse(`${p.year!.padStart(4, '0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); }; let instant = target;
  for (let i = 0; i < 5; i++) { const next = instant + target - observed(instant); if (next === instant) break; instant = next; }
  if (observed(instant) !== target) throw new DomainError('LOCAL_TIME_UNAVAILABLE', '该日期的本地时间不存在，请选择其他时间');
  for (const minutes of [-120, -90, -60, -30, 30, 60, 90, 120]) if (observed(instant + minutes * 60000) === target) throw new DomainError('LOCAL_TIME_AMBIGUOUS', '该日期的本地时间因夏令时出现两次，请选择其他时间'); return instant / 1000;
}
