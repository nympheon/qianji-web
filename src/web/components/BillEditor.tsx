import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BillDetail, LedgerOptions } from '../../features/ledger/contract';
import type { BillDraft, BillChanges } from '../../features/ledger/write-contract';
import { newBillSchema } from '../../features/ledger/write-contract';
import type { OperationView } from '../../operations/contract';
import { addMoney } from '../../shared/numbers';
import { api } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';
import { OperationStatus } from './OperationStatus';

export function BillEditor({ options, bill, onComplete }: { options: LedgerOptions | null; bill?: BillDetail; onComplete(): void }) {
  const key = bill ? `edit:${bill.id}` : 'new';
  const initial = (): BillDraft => ({ kind: bill ? 'edit' : 'create', requestId: crypto.randomUUID(), fields: bill ? {
    bookId: bill.bookId, categoryId: bill.categoryId ?? undefined, type: bill.type as 0 | 1 | 5,
    enteredMoney: addMoney(bill.money, bill.transferFee.startsWith('-') ? bill.transferFee.slice(1) : bill.transferFee), fee: bill.transferFee,
    remark: bill.remark, timeSec: bill.timeSec, countInStatistics: !(bill.flags & 1), countInBudget: !(bill.flags & 2),
  } : { bookId: options?.books[0]?.id, categoryId: options?.categories[0]?.id, type: 0, enteredMoney: '', fee: '0', timeSec: Math.floor(Date.now() / 1000), remark: '' }, ...(bill ? { billId: bill.id, expectedVersion: bill.editVersion } : {}) });
  const [draft, setDraft] = useState<BillDraft>(initial), [loaded, setLoaded] = useState(false), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationView | null>(null), [operationId, setOperationId] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true);
  const baseline = useRef<BillChanges>(draft.fields);
  const persist = (value: BillDraft) => {
    const task = queue.current.then(() => api('ledger.draft.save', { key, draft: value })); queue.current = task;
    return task.then((reply) => { if (mounted.current) { setSaved(reply.status === 'ready'); if (reply.error) setError(reply.error.message); } return reply; });
  };
  useEffect(() => {
    let active = true; mounted.current = true;
    void api('ledger.draft.get', { key }).then((reply) => {
      if (!active) return;
      if (reply.data) { setDraft(reply.data.draft); setOperationId(reply.data.operationId); setSaved(true); }
      else if (reply.error) setError(reply.error.message);
      setLoaded(true);
    });
    return () => { active = false; mounted.current = false; };
  }, [key]);
  useEffect(() => {
    if (!loaded || operationId || busy) return;
    const timer = setTimeout(() => { void persist(draft); }, 400);
    return () => clearTimeout(timer);
  }, [draft, loaded, operationId, busy]);
  function change(fields: Partial<BillChanges>) { setDraft({ ...draft, fields: { ...draft.fields, ...fields } }); setSaved(false); setError(null); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || operationId || !loaded) return;
    const parsed = newBillSchema.safeParse(draft.fields);
    if (!parsed.success) { setError('请完整填写账本、分类、类型、金额和时间，金额请使用十进制数字。'); return; }
    setBusy(true); setError(null);
    try {
      const savedReply = await persist(draft); if (savedReply.status !== 'ready') return;
      const changes = Object.fromEntries(Object.entries(parsed.data).filter(([name, value]) => JSON.stringify(baseline.current[name as keyof BillChanges]) !== JSON.stringify(value)));
      if (draft.kind === 'edit' && (!draft.billId || !draft.expectedVersion)) { setError('请重新载入账单详情后编辑。'); return; }
      if (draft.kind === 'edit' && !Object.keys(changes).length) { setError('尚未修改账单。'); return; }
      const reply = draft.kind === 'edit'
        ? await api('ledger.edit', { requestId: draft.requestId, bills: [{ id: draft.billId!, expectedVersion: draft.expectedVersion!, changes }] })
        : await api('ledger.create', { requestId: draft.requestId, bills: [parsed.data] });
      if (reply.data) { setOperation(reply.data); setOperationId(reply.data.id); if (reply.data.state === 'succeeded') onComplete(); }
      else {
        // A browser timeout can hide an accepted operation: recover by the original key.
        const recovery = await api('ledger.draft.get', { key });
        if (recovery.data?.operationId) setOperationId(recovery.data.operationId);
        setError(reply.error?.message ?? '未取得操作结果，请保留草稿并查看原操作。');
      }
    } finally { setBusy(false); }
  }
  const disabled = !loaded || busy || !!operationId;
  const time = draft.fields.timeSec === undefined ? '' : new Date(draft.fields.timeSec * 1000 - new Date(draft.fields.timeSec * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return <form onSubmit={(event) => { void submit(event); }} className="bill-editor"><FieldGroup>
    <div className="editor-grid"><Field><FieldLabel>账本</FieldLabel><Select value={draft.fields.bookId ?? ''} disabled={disabled} onValueChange={(bookId) => change({ bookId })}><SelectTrigger aria-label="记账账本"><SelectValue placeholder="选择账本" /></SelectTrigger><SelectContent>{options?.books.map((book) => <SelectItem key={book.id} value={book.id}>{book.name}</SelectItem>)}</SelectContent></Select></Field>
    <Field><FieldLabel>类型</FieldLabel><Select value={String(draft.fields.type ?? 0)} disabled={disabled} onValueChange={(type) => change({ type: Number(type) as 0 | 1 | 5, ...(type === '1' ? { fee: '0' } : {}) })}><SelectTrigger aria-label="记账类型"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="0">支出</SelectItem><SelectItem value="1">收入</SelectItem><SelectItem value="5">待报销支出</SelectItem></SelectContent></Select></Field>
    <Field><FieldLabel htmlFor="bill-entered-money">录入金额</FieldLabel><Input id="bill-entered-money" inputMode="decimal" value={draft.fields.enteredMoney ?? ''} disabled={disabled} onChange={(event) => change({ enteredMoney: event.target.value })} required /></Field>
    <Field><FieldLabel htmlFor="bill-fee">优惠（负数）</FieldLabel><Input id="bill-fee" inputMode="decimal" value={draft.fields.fee ?? '0'} disabled={disabled || draft.fields.type === 1} onChange={(event) => change({ fee: event.target.value })} /></Field>
    <Field><FieldLabel>分类</FieldLabel><Select value={draft.fields.categoryId ?? ''} disabled={disabled} onValueChange={(categoryId) => change({ categoryId })}><SelectTrigger aria-label="记账分类"><SelectValue placeholder="选择分类" /></SelectTrigger><SelectContent>{options?.categories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectContent></Select></Field>
    <Field><FieldLabel htmlFor="bill-time">时间</FieldLabel><Input id="bill-time" type="datetime-local" value={time} disabled={disabled} onChange={(event) => { const ms = new Date(event.target.value).getTime(); if (Number.isFinite(ms)) change({ timeSec: Math.floor(ms / 1000) }); }} required /></Field></div>
    <Field><FieldLabel htmlFor="bill-remark">备注</FieldLabel><Textarea id="bill-remark" value={draft.fields.remark ?? ''} maxLength={500} disabled={disabled} onChange={(event) => change({ remark: event.target.value })} /></Field>
    <div className="flex flex-wrap gap-4 text-sm"><label><input type="checkbox" checked={draft.fields.countInStatistics !== false} disabled={disabled} onChange={(event) => change({ countInStatistics: event.target.checked })} /> 计入收支</label><label><input type="checkbox" checked={draft.fields.countInBudget !== false} disabled={disabled} onChange={(event) => change({ countInBudget: event.target.checked })} /> 计入预算</label></div>
    {error ? <p role="alert">{error}</p> : null}{operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') onComplete(); }} /> : <p className="muted-copy">{saved ? '草稿已保存' : '正在保存草稿…'}</p>}
    <Button type="submit" disabled={disabled}>{busy ? '正在提交…' : '保存账单'}</Button>
    {operation && ['succeeded', 'failed'].includes(operation.state) ? <Button type="button" variant="outline" onClick={() => { setDraft(initial()); setOperationId(null); setOperation(null); setSaved(false); }}>建立新草稿</Button> : null}
  </FieldGroup></form>;
}
