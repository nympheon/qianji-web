import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BillDetail, BillFilter, BillSummary } from '../../features/ledger/contract';
import { cancelReimbursementInputSchema, reimburseInputSchema, type ReimbursementDraft } from '../../features/ledger/reimbursement-contract';
import { operationIsFinal, type OperationView } from '../../operations/contract';
import { api } from '../api';
import { useAction } from '../lib/use-action';
import { Button } from '../components/ui/button';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { OperationStatus } from '../components/OperationStatus';
import { EmptyState } from '../components/EmptyState';
import { formatMoney } from '../components/Totals';

const key = 'reimbursements';
const labels: Record<ReimbursementDraft['mode'], string> = { reimburse: '确认报销入账', cancel: '确认取消报销', mark: '标记为待报销', unmark: '取消待报销属性', delete: '确认删除所选到账记录' };
function newDraft(): ReimbursementDraft { return { kind: 'reimbursement', requestId: crypto.randomUUID(), mode: 'reimburse', fields: { bills: [], money: '', assetId: null, timeSec: Math.floor(Date.now() / 1000), remark: '' } }; }
export function ReimbursementsPage() {
  const [filter, setFilter] = useState<BillFilter>({ types: [5], limit: 50 }), [draft, setDraft] = useState<ReimbursementDraft>(newDraft), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [selectionBusy, setSelectionBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null), [operation, setOperation] = useState<OperationView | null>(null), [selected, setSelected] = useState<Record<string, BillDetail>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true);
  const query = useAction('ledger.list', filter), options = useAction('ledger.transfer.options', {}), capabilities = useAction('capabilities.list', {});
  const base = options.data?.baseCurrency ?? 'CNY', assets = options.data?.assets.filter((asset) => ![5, 6].includes(asset.type)) ?? [];
  const action = draft.mode === 'reimburse' ? 'ledger.reimburse' : draft.mode === 'cancel' ? 'ledger.cancelReimbursement' : draft.mode === 'delete' ? 'ledger.delete' : 'ledger.setReimbursable';
  const allowed = capabilities.data?.some((item) => item.action === action && item.enabled) ?? false, disabled = !loaded || busy || !!operationId;
  const persist = (value: ReimbursementDraft) => { const task = queue.current.then(() => api('ledger.draft.save', { key, draft: value })); queue.current = task; return task.then((reply) => { if (mounted.current) { setSaved(reply.status === 'ready'); if (reply.error) setError(reply.error.message); } return reply; }); };
  useEffect(() => {
    let active = true; mounted.current = true;
    void api('ledger.draft.get', { key }).then(async (reply) => {
      if (!active) return;
      if (reply.data?.draft.kind === 'reimbursement') {
        const value = reply.data.draft; setDraft(value); setOperationId(reply.data.operationId); setSaved(true);
        setFilter({ types: [value.mode === 'mark' ? 0 : value.mode === 'delete' ? 21 : 5], limit: 50 });
        const details = await Promise.all(value.fields.bills.map((bill) => api('ledger.detail', { id: bill.id })));
        if (active) setSelected(Object.fromEntries(details.flatMap((item) => item.data ? [[item.data.id, item.data]] : [])));
      } else if (reply.error) setError(reply.error.message);
      if (active) setLoaded(true);
    });
    return () => { active = false; mounted.current = false; };
  }, []);
  useEffect(() => { if (!loaded || operationId || busy || selectionBusy) return; const timer = setTimeout(() => { void persist(draft); }, 400); return () => clearTimeout(timer); }, [draft, loaded, operationId, busy, selectionBusy]);
  function update(fields: Partial<ReimbursementDraft['fields']>) {
    let next = { ...draft.fields, ...fields };
    if (Object.hasOwn(fields, 'money') || Object.hasOwn(fields, 'assetId') || Object.hasOwn(fields, 'bills')) {
      const first = selected[next.bills[0]?.id ?? ''], source = first?.currency?.srcSymbol ?? base, target = assets.find((asset) => asset.id === next.assetId)?.currency ?? base, prior = next.currency;
      if (first?.currency || target !== base) next.currency = { srcSymbol: source, srcValue: next.money ?? '', targetSymbol: target, targetValue: target === source ? next.money ?? '' : prior?.targetSymbol === target ? prior.targetValue : '', baseSymbol: base, baseValue: source === base ? next.money ?? '' : prior?.baseValue ?? '' };
      else { const { currency: _currency, ...rest } = next; next = rest; }
    }
    setDraft({ ...draft, fields: next }); setSaved(false); setError(null);
  }
  async function choose(bill: BillSummary, checked: boolean) {
    if (!checked) { update({ bills: draft.fields.bills.filter((item) => item.id !== bill.id) }); return; }
    if (draft.fields.bills.length >= 200) { setError('单次最多选择200笔真实账单'); return; }
    setSelectionBusy(true);
    try {
      const reply = await api('ledger.detail', { id: bill.id });
      if (!reply.data?.editVersion) { setError(reply.error?.message ?? '源账单尚未载入'); return; }
      const current = reply.data; setSelected((old) => ({ ...old, [current.id]: current }));
      const fields = { ...draft.fields, bills: [...draft.fields.bills, { id: current.id, expectedVersion: current.editVersion! }] };
      if (fields.bills.length === 1) {
        const symbol = current.currency?.srcSymbol ?? base, target = assets.find((asset) => asset.id === fields.assetId)?.currency ?? base;
        if (current.currency || target !== base) fields.currency = { srcSymbol: symbol, srcValue: fields.money ?? '', targetSymbol: target, targetValue: symbol === target ? fields.money ?? '' : '', baseSymbol: base, baseValue: symbol === base ? fields.money ?? '' : '' };
        else delete fields.currency;
      }
      setDraft({ ...draft, fields }); setSaved(false); setError(null);
    } finally { setSelectionBusy(false); }
  }
  async function chooseGroup(packId: string) {
    setSelectionBusy(true);
    try {
      const reply = await api('ledger.reimbursement.members', { packId });
      if (!reply.data?.complete) { setError('组合成员尚未完整载入，请完成同步后重试'); return; }
      if (!reply.data.items.length || reply.data.items.some((item) => !item.editVersion)) { setError('组合没有可核对的真实成员'); return; }
      const members = new Map(draft.fields.bills.map((item) => [item.id, item])); for (const item of reply.data.items) members.set(item.id, { id: item.id, expectedVersion: item.editVersion! });
      if (members.size > 200) { setError('单次最多选择200笔真实账单'); return; }
      setSelected((old) => ({ ...old, ...Object.fromEntries(reply.data!.items.map((item) => [item.id, item])) })); update({ bills: [...members.values()] });
    } finally { setSelectionBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (disabled || selectionBusy || !allowed) return; setError(null);
    const parsed = draft.mode === 'reimburse' ? reimburseInputSchema.safeParse(draft.fields) : cancelReimbursementInputSchema.safeParse({ bills: draft.fields.bills });
    if (!parsed.success) { setError('请选择真实账单，并核对金额、日期和历史币种资料'); return; }
    setBusy(true);
    try {
      if ((await persist(draft)).status !== 'ready') return;
      const meta = { requestId: draft.requestId }, bills = draft.fields.bills;
      const reply = draft.mode === 'reimburse' ? await api('ledger.reimburse', { ...reimburseInputSchema.parse(parsed.data), ...meta }) : draft.mode === 'cancel' ? await api('ledger.cancelReimbursement', { bills, ...meta }) : draft.mode === 'delete' ? await api('ledger.delete', { bills, ...meta }) : await api('ledger.setReimbursable', { bills, reimbursable: draft.mode === 'mark', ...meta });
      if (reply.data) { setOperation(reply.data); setOperationId(reply.data.id); if (reply.data.state === 'succeeded') query.refetch(); }
      else { const recovery = await api('ledger.draft.get', { key }); setOperationId(recovery.data?.operationId ?? null); setError(reply.error?.message ?? '请保留草稿，核查原操作结果'); }
    } finally { setBusy(false); }
  }
  const currency = draft.fields.currency, timeSec = draft.fields.timeSec, time = timeSec === undefined ? '' : new Date(timeSec * 1000 - new Date(timeSec * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return <div className="page-stack"><a href="/bills" className="text-sm underline underline-offset-4">返回账单</a><DataStatus reply={query.reply} retained={!!query.data} /><TaskStatus jobId={query.reply?.jobId} onFinished={query.refetch} />
    <div className="flex flex-wrap gap-2">{([{ type: 0, title: '普通支出', mode: 'mark' }, { type: 5, title: '待报销', mode: 'reimburse' }, { type: 21, title: '报销到账', mode: 'delete' }] as const).map((item) => <Button key={item.type} type="button" variant={filter.types?.[0] === item.type ? 'default' : 'outline'} disabled={disabled || selectionBusy} onClick={() => { setFilter({ types: [item.type], limit: 50 }); setDraft({ ...draft, mode: item.mode, fields: { ...draft.fields, bills: [] } }); setError(null); }}>{item.title}</Button>)}</div>
    <div className="reimbursement-layout"><section className="content-section"><div className="section-heading"><h2>选择账单</h2><span className="muted-copy">已选择 {draft.fields.bills.length} 笔</span></div>
      <div className="flex flex-col divide-y">{query.data?.rows.map((row) => row.kind === 'reimbursement-group' ? <div key={row.packId} className="py-4"><strong>报销组合 · {row.members.length} 笔{row.continuedBefore || row.continuedAfter ? '（当前页）' : ''}</strong><Button type="button" variant="outline" className="mt-3 w-full" disabled={disabled || selectionBusy} aria-label={`选择完整组合 ${row.packId}`} onClick={() => { void chooseGroup(row.packId); }}>读取并选择完整组合</Button></div> : <label key={row.bill.id} className="flex cursor-pointer items-center gap-3 py-4"><input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={`选择 ${row.bill.remark || row.bill.id}`} checked={draft.fields.bills.some((item) => item.id === row.bill.id)} disabled={disabled || selectionBusy} onChange={(event) => { void choose(row.bill, event.target.checked); }} /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{row.bill.remark || '无备注'}</strong><small className="muted-copy">{new Date(row.bill.timeSec * 1000).toLocaleDateString('zh-CN')}</small></span><span className="text-sm tabular-nums">{formatMoney(row.bill.currency?.srcValue ?? row.bill.money)} {row.bill.currency?.srcSymbol ?? base}</span></label>)}</div>
      {!query.loading && !query.data?.rows.length ? <EmptyState title="暂无记录" description="当前类型没有已载入的账单。" /> : null}
      <div className="flex gap-2">{filter.cursor ? <Button variant="outline" disabled={selectionBusy} onClick={() => setFilter({ ...filter, cursor: undefined })}>返回第一页</Button> : null}{query.data?.nextCursor ? <Button variant="outline" disabled={selectionBusy} onClick={() => setFilter({ ...filter, cursor: query.data!.nextCursor! })}>下一页</Button> : null}</div>
    </section><form className="content-section" onSubmit={(event) => { void submit(event); }}><FieldGroup><h2>报销操作</h2>
      <Field><FieldLabel>操作</FieldLabel><Select value={draft.mode} disabled={disabled} onValueChange={(mode: ReimbursementDraft['mode']) => { setDraft({ ...draft, mode }); setSaved(false); setError(null); }}><SelectTrigger aria-label="报销操作"><SelectValue /></SelectTrigger><SelectContent>{filter.types?.[0] === 0 ? <SelectItem value="mark">标记待报销</SelectItem> : filter.types?.[0] === 21 ? <SelectItem value="delete">删除真实到账记录</SelectItem> : <><SelectItem value="reimburse">报销入账</SelectItem><SelectItem value="cancel">取消报销，保留待报销</SelectItem><SelectItem value="unmark">取消待报销属性</SelectItem></>}</SelectContent></Select></Field>
      {draft.mode === 'reimburse' ? <><p className="muted-copy">按源账单时间分配，末笔接收剩余金额。</p><div className="editor-grid"><Field><FieldLabel htmlFor="reimbursement-money">报销总额</FieldLabel><Input id="reimbursement-money" inputMode="decimal" value={draft.fields.money ?? ''} disabled={disabled} required onChange={(event) => update({ money: event.target.value })} /></Field><Field><FieldLabel>到账资产</FieldLabel><Select value={draft.fields.assetId ?? '-1'} disabled={disabled} onValueChange={(id) => update({ assetId: id === '-1' ? null : id })}><SelectTrigger aria-label="报销到账资产"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="-1">不关联资产</SelectItem>{assets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.name} · {asset.currency}</SelectItem>)}</SelectContent></Select></Field><Field className="col-span-full"><FieldLabel htmlFor="reimbursement-time">报销时间</FieldLabel><Input id="reimbursement-time" type="datetime-local" value={time} disabled={disabled} required onChange={(event) => { const ms = new Date(event.target.value).getTime(); if (Number.isFinite(ms)) update({ timeSec: Math.floor(ms / 1000) }); }} /></Field></div>
      {currency ? <div className="editor-grid"><Field><FieldLabel htmlFor="reimbursement-target">历史到账金额（{currency.targetSymbol}）</FieldLabel><Input id="reimbursement-target" value={currency.targetValue} inputMode="decimal" required disabled={disabled || currency.targetSymbol === currency.srcSymbol} onChange={(event) => update({ currency: { ...currency, targetValue: event.target.value } })} /></Field><Field><FieldLabel htmlFor="reimbursement-base">历史本位币金额（{base}）</FieldLabel><Input id="reimbursement-base" value={currency.baseValue} inputMode="decimal" required disabled={disabled || currency.srcSymbol === base} onChange={(event) => update({ currency: { ...currency, baseValue: event.target.value } })} /></Field></div> : null}
      <Field><FieldLabel htmlFor="reimbursement-remark">报销备注</FieldLabel><Textarea id="reimbursement-remark" maxLength={500} value={draft.fields.remark ?? ''} disabled={disabled} onChange={(event) => update({ remark: event.target.value })} /></Field></> : <p className="muted-copy">{draft.mode === 'cancel' ? '取消报销后保留待报销支出。源关系、到账记录和资产由只读同步核对。' : draft.mode === 'unmark' ? '已有报销记录的源账单将保留待报销属性。' : draft.mode === 'delete' ? '组合先展开真实成员，逐条保存删除结果并核对源关系。' : '仅改变待报销属性，保留退款和其他资料。'}</p>}
      {error ? <p role="alert">{error}</p> : null}{operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') query.refetch(); }} /> : <p className="muted-copy">{saved ? '草稿已保存' : '正在保存草稿…'}</p>}
      {!allowed ? <p className="muted-copy">{capabilities.data?.find((item) => item.action === action)?.reason ?? '写入能力等待验证'}</p> : null}<Button type="submit" variant={draft.mode === 'delete' ? 'destructive' : 'default'} disabled={disabled || selectionBusy || !allowed || !draft.fields.bills.length}>{labels[draft.mode]}</Button>
      {operation && operationIsFinal(operation) ? <Button type="button" variant="outline" onClick={() => { setDraft(newDraft()); setSelected({}); setOperationId(null); setOperation(null); setFilter({ types: [5], limit: 50 }); setError(null); setSaved(false); query.refetch(); }}>建立新草稿</Button> : null}
    </FieldGroup></form></div>
  </div>;
}
