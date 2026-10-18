import { useRef, useState } from 'react';
import { ReceiptTextIcon } from 'lucide-react';
import type { BillDetail, BillFilter, BillSummary, LedgerOptions } from '../../features/ledger/contract';
import { api } from '../api';
import { useAction } from '../lib/use-action';
import { currentMonth, Filters, monthFilter } from '../components/Filters';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { EmptyState } from '../components/EmptyState';
import { formatMoney, Totals } from '../components/Totals';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Skeleton } from '../components/ui/skeleton';
import { BillEditor } from '../components/BillEditor';
import { BillDelete } from '../components/BillDelete';
import { TransferEditor } from '../components/TransferEditor';
import { RefundEditor } from '../components/RefundEditor';

const billTypes: Record<number, string> = { 0: '支出', 1: '收入', 2: '转账', 3: '信用卡还款', 4: '债务还款', 5: '待报销', 6: '借入', 7: '借出', 9: '债务收款', 10: '利息支出', 11: '利息收入', 20: '退款', 21: '报销到账' };
function category(bill: BillSummary, options: LedgerOptions | null) { return options?.categories.find((item) => item.id === bill.categoryId)?.name ?? billTypes[bill.type] ?? '其他账单'; }
export function BillsPage({ initialDate }: { initialDate?: BillFilter['date'] }) {
  const [filter, setFilter] = useState<BillFilter>({ date: initialDate ?? monthFilter(currentMonth()) }), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<BillDetail | null>(null), [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef<string | null>(null);
  const [refundSource, setRefundSource] = useState<BillDetail | null>(null);
  const [editor, setEditor] = useState<'create' | 'edit' | 'delete' | 'transfer' | 'repay-card' | 'transfer-edit' | 'transfer-delete' | 'refund' | null>(null), [editorBill, setEditorBill] = useState<BillDetail | undefined>(undefined);
  const { cursor: _cursor, limit: _limit, order: _order, groupReimbursements: _group, ...statFilter } = filter;
  const query = useAction('ledger.list', filter), options = useAction('ledger.options', {}), statistics = useAction('ledger.statistics', { currency: 'CNY', filter: statFilter });
  const capabilities = useAction('capabilities.list', {}), allowed = (action: string) => capabilities.data?.some((item) => item.action === action && item.enabled) ?? false;
  const transferOptions = useAction('ledger.transfer.options', {});
  const complete = () => { query.refetch(); statistics.refetch(); };
  // Statistics have a stricter schema: pagination belongs only to the bill query.
  const name = (bill: BillSummary) => category(bill, options.data);
  async function showDetail(bill: BillSummary) { detailRequest.current = bill.id; setSelected(bill.id); setDetail(null); setDetailError(null); const reply = await api('ledger.detail', { id: bill.id }); if (detailRequest.current !== bill.id) return; setDetail(reply.data); setDetailError(reply.error?.message ?? null); }
  async function editRefund(bill: BillDetail) {
    if (!bill.refundSourceId) { setDetailError('退款源账单尚未载入'); return; }
    const reply = await api('ledger.detail', { id: bill.refundSourceId });
    if (detailRequest.current !== bill.id) return;
    if (!reply.data) { setDetailError(reply.error?.message ?? '源账单尚未载入'); return; }
    setRefundSource(reply.data); setEditorBill(bill); setSelected(null); setEditor('refund');
  }
  return <div className="page-stack"><DataStatus reply={query.reply} retained={!!query.data} /><TaskStatus jobId={query.reply?.jobId} onFinished={query.refetch} /><Filters filter={filter} options={options.data} onChange={setFilter} /><Totals totals={statistics.data?.totals ?? null} />
    <div className="flex flex-wrap items-center gap-3"><Button variant="outline" asChild><a href="/reimbursements">报销管理</a></Button><Button disabled={!allowed('ledger.create')} onClick={() => { setEditorBill(undefined); setEditor('create'); }}>记一笔</Button><Button variant="outline" disabled={!allowed('ledger.transfer') || !transferOptions.data} onClick={() => { setEditorBill(undefined); setEditor('transfer'); }}>转账</Button><Button variant="outline" disabled={!allowed('ledger.repayCard') || !transferOptions.data} onClick={() => { setEditorBill(undefined); setEditor('repay-card'); }}>信用卡还款</Button>{!allowed('ledger.create') ? <p className="muted-copy">{capabilities.data?.find((item) => item.action === 'ledger.create')?.reason ?? '写入能力等待验证'}</p> : null}</div>
    {statistics.data && statistics.reply?.status !== 'ready' ? <p className="muted-copy">收支汇总保留上次计算结果，等待完整同步。</p> : null}
    {filter.date?.kind === 'day' ? <p className="muted-copy">日期：{filter.date.date}</p> : null}
    <section className="ledger-surface"><div className="desktop-ledger"><Table><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>分类与备注</TableHead><TableHead>账本</TableHead><TableHead>资产</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader><TableBody>{query.data?.items.map((bill) => <TableRow key={bill.id}><TableCell>{new Date(bill.timeSec * 1000).toLocaleDateString('zh-CN', { timeZone: filter.zone ?? 'Asia/Shanghai' })}</TableCell><TableCell><Button variant="ghost" className="bill-label" aria-label={`查看 ${bill.remark || name(bill)}`} onClick={() => { void showDetail(bill); }}><ReceiptTextIcon data-icon="inline-start" /><span><strong>{name(bill)}</strong><small>{bill.remark || billTypes[bill.type]}</small></span></Button></TableCell><TableCell>{options.data?.books.find((book) => book.id === bill.bookId)?.name ?? bill.bookId}</TableCell><TableCell>—</TableCell><TableCell className="text-right"><BillAmount bill={bill} /></TableCell></TableRow>)}</TableBody></Table></div>
      <div className="mobile-ledger">{query.data?.items.map((bill, index, all) => {
        const day = new Date(bill.timeSec * 1000).toLocaleDateString('zh-CN', { timeZone: filter.zone ?? 'Asia/Shanghai' }), previous = all[index - 1];
        return <div key={bill.id}>{!previous || new Date(previous.timeSec * 1000).toLocaleDateString('zh-CN', { timeZone: filter.zone ?? 'Asia/Shanghai' }) !== day ? <p className="bill-day">{day}</p> : null}<button className="mobile-bill" aria-label={`查看 ${bill.remark || name(bill)}`} onClick={() => { void showDetail(bill); }}><ReceiptTextIcon /><span><strong>{name(bill)}</strong><small>{bill.remark || billTypes[bill.type]}</small></span><BillAmount bill={bill} /></button></div>;
      })}</div>
      {query.loading && !query.data ? <div className="flex flex-col gap-3 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : !query.data?.items.length ? <EmptyState title={query.reply?.status === 'running' ? '正在载入账单' : '暂无账单'} description={query.reply?.status === 'running' ? '同步任务已保存，载入后会显示真实账单。' : '当前筛选范围没有账单。'} /> : null}
    </section>
    <div className="flex gap-2">{filter.cursor ? <Button variant="outline" onClick={() => setFilter({ ...filter, cursor: undefined })}>返回第一页</Button> : null}{query.data?.nextCursor ? <Button variant="outline" onClick={() => setFilter({ ...filter, cursor: query.data!.nextCursor! })}>下一页</Button> : null}</div>
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) { detailRequest.current = null; setSelected(null); } }}><DialogContent><DialogHeader><DialogTitle>账单详情</DialogTitle><DialogDescription>{detail?.remark || '真实账单与关联记录'}</DialogDescription></DialogHeader>{detailError ? <p role="alert">{detailError}</p> : detail ? <div className="detail-content"><BillAmount bill={detail} /><dl><dt>类型</dt><dd>{billTypes[detail.type] ?? '其他'}</dd><dt>日期</dt><dd>{new Date(detail.timeSec * 1000).toLocaleString('zh-CN')}</dd><dt>备注</dt><dd>{detail.remark || '—'}</dd><dt>手续费 / 优惠</dt><dd>{detail.transferFee}</dd><dt>关联退款</dt><dd>{detail.refunds.length} 笔</dd><dt>关联报销</dt><dd>{detail.reimbursements.length} 笔</dd></dl><DataStatus reply={{ status: detail.freshness.complete ? 'ready' : 'partial', data: detail, freshness: detail.freshness }} /><div className="flex gap-2"><Button variant="outline" disabled={!([2, 3].includes(detail.type) ? allowed(detail.type === 3 ? 'ledger.repayCard' : 'ledger.transfer') : allowed(detail.type === 20 ? 'ledger.refund' : 'ledger.edit')) || ![0, 1, 2, 3, 5, 20].includes(detail.type)} onClick={() => { if (detail.type === 20) { void editRefund(detail); return; } setEditorBill(detail); setSelected(null); setEditor([2, 3].includes(detail.type) ? 'transfer-edit' : 'edit'); }}>编辑账单</Button><Button variant="destructive" disabled={!([2, 3].includes(detail.type) ? allowed(detail.type === 3 ? 'ledger.repayCard' : 'ledger.transfer') : allowed('ledger.delete')) || ![0, 1, 2, 3, 5, 20, 21].includes(detail.type)} onClick={() => { setEditorBill(detail); setSelected(null); setEditor([2, 3].includes(detail.type) ? 'transfer-delete' : 'delete'); }}>删除账单</Button>{[0, 5].includes(detail.type) ? <Button variant="outline" disabled={!allowed('ledger.refund')} onClick={() => { setRefundSource(detail); setEditorBill(undefined); setSelected(null); setEditor('refund'); }}>新增退款</Button> : null}</div></div> : <Skeleton className="h-36 w-full" />}</DialogContent></Dialog>
    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open) setEditor(null); }}><DialogContent className="editor-dialog"><DialogHeader><DialogTitle>{editor === 'create' ? '记一笔' : editor === 'edit' ? '编辑账单' : editor === 'delete' ? '删除账单' : editor === 'repay-card' ? '信用卡还款' : editor === 'transfer-edit' ? '编辑转账或还款' : editor === 'transfer-delete' ? '删除转账或还款' : editor === 'refund' ? '退款' : '转账'}</DialogTitle><DialogDescription>{editor === 'delete' || editor === 'transfer-delete' ? '逐项确认钱迹删除回执' : '草稿自动保存，提交后可查看原操作结果'}</DialogDescription></DialogHeader>{editor === 'refund' && refundSource ? <RefundEditor key={`${refundSource.id}:${editorBill?.id ?? 'new'}`} source={refundSource} {...(editorBill ? { refund: editorBill } : {})} options={transferOptions.data} onComplete={complete} /> : editor && ['transfer', 'repay-card', 'transfer-edit', 'transfer-delete'].includes(editor) ? <TransferEditor key={`${editor}:${editorBill?.id ?? 'new'}`} kind={editor === 'repay-card' || editorBill?.type === 3 ? 'repay-card' : 'transfer'} mode={editor === 'transfer-edit' ? 'edit' : editor === 'transfer-delete' ? 'delete' : 'create'} options={transferOptions.data} {...(editorBill ? { bill: editorBill } : {})} onComplete={complete} /> : editor === 'delete' && editorBill ? <BillDelete bill={editorBill} onComplete={complete} /> : editor ? <BillEditor key={editorBill?.id ?? 'new'} options={options.data} {...(editorBill ? { bill: editorBill } : {})} onComplete={complete} /> : null}</DialogContent></Dialog>
  </div>;
}
function BillAmount({ bill }: { bill: BillSummary }) { const income = [1, 11].includes(bill.type); return <span className={income ? 'bill-money money-income' : [0, 10].includes(bill.type) ? 'bill-money money-spend' : 'bill-money'}>{income ? '+' : [0, 10].includes(bill.type) ? '−' : ''}¥ {formatMoney(bill.money)}</span>; }
