import { lazy, Suspense, useEffect, useState, type MouseEvent } from 'react';
import { ChartNoAxesColumnIcon, CalendarDaysIcon, HomeIcon, LayoutGridIcon, ReceiptTextIcon, RefreshCwIcon } from 'lucide-react';
import type { ConnectionView } from '../features/connection/contract';
import type { AppReply } from '../shared/reply';
import { api, clearClientCache } from './api';
import { useAction } from './lib/use-action';
import { cn } from './lib/utils';
import { Button } from './components/ui/button';
import { Skeleton } from './components/ui/skeleton';
import { DataStatus } from './components/DataStatus';
import { TaskStatus } from './components/TaskStatus';
const ConnectionPage = lazy(() => import('./pages/ConnectionPage').then((module) => ({ default: module.ConnectionPage })));
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((module) => ({ default: module.OverviewPage })));
const BillsPage = lazy(() => import('./pages/BillsPage').then((module) => ({ default: module.BillsPage })));
const ReimbursementsPage = lazy(() => import('./pages/ReimbursementsPage').then((module) => ({ default: module.ReimbursementsPage })));
const AssetsPage = lazy(() => import('./pages/AssetsPage').then((module) => ({ default: module.AssetsPage })));
const DebtPage = lazy(() => import('./pages/DebtPage').then((module) => ({ default: module.DebtPage })));
const CalendarPage = lazy(() => import('./pages/CalendarPage').then((module) => ({ default: module.CalendarPage })));
const StatisticsPage = lazy(() => import('./pages/StatisticsPage').then((module) => ({ default: module.StatisticsPage })));
const ServicePage = lazy(() => import('./pages/ServicePage').then((module) => ({ default: module.ServicePage })));

const navigation = [{ path: '/', title: '总览', icon: HomeIcon }, { path: '/bills', title: '账单', icon: ReceiptTextIcon }, { path: '/calendar', title: '日历', icon: CalendarDaysIcon }, { path: '/statistics', title: '统计', icon: ChartNoAxesColumnIcon }, { path: '/service', title: '服务', icon: LayoutGridIcon }];
export function App() {
  const query = useAction('connection.status', {}), [current, setCurrent] = useState<ConnectionView | null>(null), [path, setPath] = useState(window.location.pathname + window.location.search), [generation, setGeneration] = useState(0), [syncReply, setSyncReply] = useState<AppReply<unknown> | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { if (query.data) setCurrent(query.data); }, [query.data]);
  useEffect(() => { const pop = () => setPath(window.location.pathname + window.location.search); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  function navigate(next: string) { if (next !== path) { history.pushState({}, '', next); setPath(next); window.scrollTo(0, 0); } }
  function follow(event: MouseEvent<HTMLAnchorElement>, next: string) { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(next); } }
  function onConnected(view: ConnectionView) { setSyncReply(null); clearClientCache(); setCurrent(view); setGeneration((value) => value + 1); navigate('/bills'); }
  const pathname = path.split('?')[0]!, title = pathname === '/debt' ? '借贷' : pathname === '/assets' ? '资产' : pathname === '/reimbursements' ? '报销' : navigation.find((item) => item.path === pathname)?.title ?? '账单';
  const connectionPage = pathname === '/connection' || (!!query.reply && !current?.uid);
  const active = connectionPage ? '/bills' : pathname;
  const nav = <>{navigation.map(({ path: next, title, icon: Icon }) => <a key={next} href={next} onClick={(event) => follow(event, next)} aria-current={active === next ? 'page' : undefined} className={cn('nav-link', active === next && 'active')}><Icon /><span>{title}</span></a>)}</>;
  return <div className="app-shell"><aside className="app-sidebar"><a className="brand" href="/" onClick={(event) => follow(event, '/')}>钱迹</a><nav aria-label="主导航">{nav}</nav><a className="sidebar-account" href="/connection" onClick={(event) => follow(event, '/connection')}>{current?.state === 'connected' ? current.user?.name || '已连接钱迹' : '连接钱迹'}</a></aside><div className="app-main"><div className="mobile-brand">钱迹</div>{!connectionPage ? <header className="page-header"><h1>{title}</h1><Button disabled={busy || current?.state !== 'connected'} onClick={async () => { setBusy(true); try { setSyncReply(await api('sync.start', { domain: 'ledger', mode: 'incremental' })); setGeneration((value) => value + 1); } finally { setBusy(false); } }}><RefreshCwIcon data-icon="inline-start" />{busy ? '正在同步…' : '同步'}</Button></header> : null}
    <main><Suspense fallback={<Skeleton className="h-48 w-full" />}>{!query.reply ? <div className="page-stack"><Skeleton className="h-10 w-40" /><Skeleton className="h-48 w-full" /></div> : connectionPage ? <ConnectionPage current={current} onConnected={onConnected} /> : <div key={`${generation}:${current?.connectionEpoch}:${path}`}>
      {syncReply?.error ? <DataStatus reply={syncReply} /> : null}{syncReply?.status === 'running' && pathname === '/service' ? <TaskStatus jobId={syncReply.jobId} onFinished={() => setSyncReply(null)} /> : null}
      {pathname === '/' ? <OverviewPage /> : pathname === '/bills' ? <BillsPage {...(new URLSearchParams(path.split('?')[1]).get('day') ? { initialDate: { kind: 'day', date: new URLSearchParams(path.split('?')[1]).get('day')! } } : {})} /> : pathname === '/debt' ? <DebtPage /> : pathname === '/assets' ? <AssetsPage /> : pathname === '/reimbursements' ? <ReimbursementsPage /> : pathname === '/calendar' ? <CalendarPage onDay={(date) => navigate(`/bills?day=${date}`)} /> : pathname === '/statistics' ? <StatisticsPage /> : pathname === '/service' ? <ServicePage current={current} onConnection={(view) => { clearClientCache(); setCurrent(view); setGeneration((value) => value + 1); }} /> : <OverviewPage />}
    </div>}</Suspense></main>
  </div><nav className="mobile-nav" aria-label="手机导航">{nav}</nav></div>;
}
