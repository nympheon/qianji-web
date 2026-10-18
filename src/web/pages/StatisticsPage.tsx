import { useState } from 'react';
import { compareMoney, divideMoney, subtractMoney } from '../../shared/numbers';
import type { BillFilter, StatisticsInput } from '../../features/ledger/contract';
import { useAction } from '../lib/use-action';
import { currentMonth, Filters, monthFilter } from '../components/Filters';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { EmptyState } from '../components/EmptyState';
import { formatMoney, Totals } from '../components/Totals';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export function StatisticsPage() {
  const [filter, setFilter] = useState<BillFilter>({ date: monthFilter(currentMonth()) }), [currency, setCurrency] = useState('CNY'), [trend, setTrend] = useState<'day' | 'month' | 'year'>('day'), [dimension, setDimension] = useState<'category' | 'tag' | 'member' | 'asset'>('category'), [comparison, setComparison] = useState('');
  const options = useAction('ledger.options', {});
  const input: StatisticsInput = { filter, currency, trend, dimensions: [dimension], ...(comparison ? { comparison: { kind: 'month', year: Number(comparison.slice(0, 4)), month: Number(comparison.slice(5, 7)) } } : {}) };
  const query = useAction('ledger.statistics', input);
  let maximum = '0'; for (const point of query.data?.trend ?? []) for (const value of [point.totals.totalSpend, point.totals.totalIncome]) { const abs = compareMoney(value, '0') < 0 ? subtractMoney('0', value) : value; if (compareMoney(abs, maximum) > 0) maximum = abs; }
  const barWidth = (value: string) => { const absolute = compareMoney(value, '0') < 0 ? subtractMoney('0', value) : value; return maximum === '0' ? '0%' : `${Number(divideMoney(absolute, maximum)) * 100}%`; };
  return <div className="page-stack"><DataStatus reply={query.reply} retained={!!query.data} /><TaskStatus jobId={query.reply?.jobId} onFinished={query.refetch} /><Filters filter={filter} options={options.data} onChange={setFilter} />
    <div className="statistics-controls"><FieldGroup><div className="grid grid-cols-2 gap-4"><Field><FieldLabel htmlFor="stat-currency">历史币种</FieldLabel><Input id="stat-currency" value={currency} maxLength={20} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></Field><Field><FieldLabel htmlFor="compare-month">比较月份</FieldLabel><Input id="compare-month" type="month" value={comparison} onChange={(event) => setComparison(event.target.value)} /></Field></div></FieldGroup></div>
    <Totals totals={query.data?.totals ?? null} currency={currency} />
    {query.reply?.status === 'running' && query.data ? <p className="muted-copy">当前保留上次计算结果，完整同步后重新计算。</p> : null}
    {query.data?.incompleteReasons.length ? <Alert><AlertDescription>部分资料尚不完整，暂不能将此结果视为完整收支。</AlertDescription></Alert> : null}
    <section className="content-section"><div className="section-heading"><h2>收支趋势</h2><ToggleGroup type="single" value={trend} onValueChange={(value) => { if (value === 'day' || value === 'month' || value === 'year') setTrend(value); }} aria-label="趋势粒度"><ToggleGroupItem value="day">日</ToggleGroupItem><ToggleGroupItem value="month">月</ToggleGroupItem><ToggleGroupItem value="year">年</ToggleGroupItem></ToggleGroup></div>
      {query.data?.trend.length ? <div className="trend-chart">{query.data.trend.map((point) => <div className="trend-line" key={point.period}><span>{point.period}</span><div className="trend-bars"><div className="spend-bar" style={{ width: barWidth(point.totals.totalSpend) }} /><div className="income-bar" style={{ width: barWidth(point.totals.totalIncome) }} /></div><span><span className="money-spend">{formatMoney(point.totals.totalSpend)}</span><span className="money-income">{formatMoney(point.totals.totalIncome)}</span></span></div>)}</div> : <EmptyState title={query.reply?.status === 'running' ? '等待完整账单' : '暂无统计数据'} description="完整载入后，按账单保存的历史金额计算收支。" />}
    </section>
    <section className="content-section"><div className="section-heading"><h2>分组统计</h2><ToggleGroup type="single" value={dimension} onValueChange={(value) => { if (value === 'category' || value === 'tag' || value === 'member' || value === 'asset') setDimension(value); }} aria-label="分组维度"><ToggleGroupItem value="category">分类</ToggleGroupItem><ToggleGroupItem value="tag">标签</ToggleGroupItem><ToggleGroupItem value="member">成员</ToggleGroupItem><ToggleGroupItem value="asset">资产</ToggleGroupItem></ToggleGroup></div>
      {query.data?.groups[0]?.overlapping ? <p className="muted-copy">此分组可能包含重叠金额，请以收支总额为准。</p> : null}
      <Table><TableHeader><TableRow><TableHead>名称</TableHead><TableHead className="text-right">支出</TableHead><TableHead className="text-right">收入</TableHead></TableRow></TableHeader><TableBody>{query.data?.groups[0]?.items.map((group) => <TableRow key={group.key}><TableCell>{group.key === '-1' ? '未指定' : options.data?.categories.find((item) => item.id === group.key)?.name ?? options.data?.tags.find((item) => item.id === group.key)?.name ?? group.key}</TableCell><TableCell className="text-right">{formatMoney(group.totals.totalSpend)}</TableCell><TableCell className="text-right">{formatMoney(group.totals.totalIncome)}</TableCell></TableRow>)}</TableBody></Table>
    </section>
    {query.data?.comparison ? <section className="content-section"><h2>同期比较 · {comparison}</h2><Totals totals={query.data.comparison.totals} currency={currency} /></section> : null}
  </div>;
}
