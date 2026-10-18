import { useAction } from '../lib/use-action';
import { Totals } from '../components/Totals';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/ui/button';
import { formatMoney } from '../components/Totals';

export function OverviewPage() {
  const query = useAction('ledger.statistics', { currency: 'CNY', filter: { date: { kind: 'this-month' } } }), recent = useAction('ledger.list', { limit: 5 });
  return <div className="page-stack"><div className="flex flex-wrap gap-2"><Button variant="outline" asChild><a href="/assets">资产管理</a></Button><Button variant="outline" asChild><a href="/reimbursements">报销管理</a></Button></div><DataStatus reply={query.reply} retained={!!query.data} /><TaskStatus jobId={query.reply?.jobId} onFinished={query.refetch} /><p className="muted-copy">本月收支</p><Totals totals={query.data?.totals ?? null} /><section className="content-section"><div className="section-heading"><h2>最近账单</h2><Button variant="link" asChild><a href="/bills">查看全部</a></Button></div>{recent.data?.items.length ? <div className="recent-list">{recent.data.items.map((bill) => <div key={bill.id}><span>{bill.remark || '账单'}</span><span className="bill-money">¥ {formatMoney(bill.money)}</span></div>)}</div> : <EmptyState />}</section></div>;
}
