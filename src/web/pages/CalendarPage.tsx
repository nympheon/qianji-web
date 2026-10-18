import { useRef, useState } from 'react';
import { currentMonth } from '../components/Filters';
import { useAction } from '../lib/use-action';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Field, FieldLabel } from '../components/ui/field';
import { api } from '../api';
import type { CalendarView } from '../../features/ledger/contract';

export function CalendarPage({ onDay }: { onDay: (date: string) => void }) {
  const [month, setMonth] = useState(currentMonth()), [continued, setContinued] = useState<{ base: CalendarView; value: CalendarView } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const query = useAction('ledger.calendar', { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) });
  const base = useRef(query.data); base.current = query.data;
  const view = continued && continued.base === query.data ? continued.value : query.data;
  async function loadMore() {
    if (!query.data || !view?.nextCursor || busy) return;
    const snapshot = query.data; setBusy(true); setError(null);
    try {
      const reply = await api('ledger.calendar', { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)), cursor: view.nextCursor });
      if (base.current !== snapshot) return;
      if (!reply.data || reply.data.freshness.revision !== snapshot.freshness.revision) { setError(reply.error?.message ?? '账单已变化，请重新打开本月日历'); return; }
      const counts = new Map(view.days.map((day) => [day.date, day.count]));
      for (const day of reply.data.days) counts.set(day.date, (counts.get(day.date) ?? 0) + day.count);
      setContinued({ base: snapshot, value: { ...reply.data, days: [...counts].map(([date, count]) => ({ date, count })) } });
    } finally { setBusy(false); }
  }
  const firstWeekday = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  return <div className="page-stack"><DataStatus reply={query.reply} /><TaskStatus jobId={query.reply?.jobId} onFinished={query.refetch} /><Field className="max-w-56"><FieldLabel htmlFor="calendar-month">自然月</FieldLabel><Input id="calendar-month" type="month" value={month} onChange={(event) => { if (event.target.value) { setMonth(event.target.value); setContinued(null); setError(null); } }} /></Field>{error ? <p role="alert">{error}</p> : null}<section className="calendar-surface"><div className="calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: firstWeekday }, (_, index) => <div aria-hidden="true" key={`pad-${index}`} />)}{view?.days.map((day) => <button key={day.date} className={day.count ? 'calendar-day has-bills' : 'calendar-day'} aria-label={`${day.date} · ${day.count} 笔账单`} onClick={() => onDay(day.date)}><strong>{Number(day.date.slice(8))}</strong><span>{day.count ? `${day.count} 笔` : ''}</span></button>)}</div></section>{view?.nextCursor ? <Button variant="outline" disabled={busy} onClick={() => { void loadMore(); }}>继续计算本月日历</Button> : null}</div>;
}
