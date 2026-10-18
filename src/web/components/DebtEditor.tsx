import { useEffect, useRef, useState, type FormEvent } from 'react';
import { debtDraftSchema, debtWriteSchemas, type DebtDraft } from '../../features/debt/contract';
import type { TransferOptions } from '../../features/ledger/transfer-contract';
import type { OperationView } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import { splitDebtPayment } from '../../features/debt/accounting';
import { api } from '../api';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { OperationStatus } from './OperationStatus';
import { Attachments } from './Attachments';
export function DebtEditor({ initial, draftKey, options, allowed, balance, direction, onComplete }: { initial: DebtDraft; draftKey: string; options: TransferOptions; allowed: boolean; balance?: string; direction: 'borrow' | 'lend'; onComplete(): void }) {
  const [draft, setDraft] = useState(initial), [loaded, setLoaded] = useState(false), [loadAttempt, setLoadAttempt] = useState(0), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [operationId, setOperationId] = useState<string | null>(null), [operation, setOperation] = useState<OperationView | null>(null);
  const [imagesPending, setImagesPending] = useState(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true);
  const persist = (value: DebtDraft) => { const task = queue.current.then(() => api('debt.draft.save', { key: draftKey, draft: value })); queue.current = task; return task.then((reply) => { if (mounted.current) { setSaved(reply.status === 'ready'); if (reply.error) setError(reply.error.message); } return reply; }); };
  useEffect(() => { let active = true; mounted.current = true; setLoaded(false); void api('debt.draft.get', { key: draftKey }).then((reply) => { if (!active) return; if (reply.data) { if (reply.data.draft.action !== initial.action) { setError('原草稿类型不匹配，请保留原操作'); return; } setDraft(reply.data.draft); setOperationId(reply.data.operationId); setSaved(true); } setError(reply.error?.message ?? null); setLoaded(reply.status === 'ready' && !reply.error); }); return () => { active = false; mounted.current = false; }; }, [draftKey,loadAttempt]);
  useEffect(() => { if (!loaded || busy || operationId) return; const timer = setTimeout(() => { void persist(draft); }, 400); return () => clearTimeout(timer); }, [draft, loaded, busy, operationId]);
  const fields = draft.action === 'debt.editPrincipal' ? draft.input.changes : draft.input;
  function patch(value: Record<string, unknown>) {
    const input = draft.action === 'debt.editPrincipal' ? { ...draft.input, changes: { ...draft.input.changes, ...value } } : { ...draft.input, ...value }, next = debtDraftSchema.safeParse({ ...draft, input });
    if (!next.success) { setError('输入超出草稿范围，请核对'); return; } setDraft(next.data); setSaved(false); setError(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!loaded || busy || operationId || !allowed || imagesPending) return;
    const parsed = debtWriteSchemas[draft.action].safeParse(draft.input); if (!parsed.success) { setError('请完整填写本金、日期及本次操作所需资料'); return; }
    setBusy(true); setError(null);
    try {
      if ((await persist(draft)).status !== 'ready') return;
      // Keep the action/input discriminant through this shared typed boundary.
      const valid = debtDraftSchema.parse({ ...draft, input: parsed.data });
      const reply = valid.action === 'debt.create' ? await api('debt.create', { ...debtWriteSchemas['debt.create'].parse(valid.input), requestId: valid.requestId }) : valid.action === 'debt.appendPrincipal' ? await api('debt.appendPrincipal', { ...debtWriteSchemas['debt.appendPrincipal'].parse(valid.input), requestId: valid.requestId }) : valid.action === 'debt.editPrincipal' ? await api('debt.editPrincipal', { ...debtWriteSchemas['debt.editPrincipal'].parse(valid.input), requestId: valid.requestId }) : await api('debt.pay', { ...debtWriteSchemas['debt.pay'].parse(valid.input), requestId: valid.requestId });
      if (reply.data) { setOperation(reply.data); setOperationId(reply.data.id); if (reply.data.state === 'succeeded') onComplete(); }
      else { const recovery = await api('debt.draft.get', { key: draftKey }); setOperationId(recovery.data?.operationId ?? null); setError(reply.error?.message ?? '请保留草稿并核查原操作'); }
    } finally { setBusy(false); }
  }
  async function renew() {
    if (!operation || !operationIsFinal(operation)) return; setBusy(true);
    try {
      let input = draft.input;
      if (draft.action !== 'debt.create') {
        const reply = draft.action === 'debt.editPrincipal' ? await api('ledger.detail', { id: draft.input.id }) : await api('assets.detail', { id: draft.input.id });
        const version = reply.data && ('asset' in reply.data ? reply.data.asset?.editVersion : reply.data.editVersion);
        if (!version) { setError(reply.error?.message ?? '请重新载入原本金或借贷资产'); return; } input = { ...draft.input, expectedVersion: version };
      } else input = initial.input;
      setDraft(debtDraftSchema.parse({ ...draft, input, requestId: crypto.randomUUID() })); setOperationId(null); setOperation(null); setSaved(false); setError(null);
    } finally { setBusy(false); }
  }
  let split: ReturnType<typeof splitDebtPayment> | null = null;
  if (draft.action === 'debt.pay' && balance !== undefined) { try { split = splitDebtPayment(balance, draft.input.principal, draft.input.interest); } catch { /* Incomplete decimal input remains a draft. */ } }
  const disabled = !loaded || busy || !!operationId, creating = draft.action === 'debt.create', cash = options.assets.filter((asset) => [1, 2, 3, 4].includes(asset.type) && asset.currency === options.baseCurrency);
  const timeSec = 'timeSec' in fields ? fields.timeSec : undefined;
  const label = creating ? '保存借贷' : draft.action === 'debt.editPrincipal' ? '保存本金记录' : draft.action === 'debt.appendPrincipal' ? '确认追加本金' : direction === 'borrow' ? '确认还款' : '确认收款';
  return <form className="bill-editor" onSubmit={(event) => { void submit(event); }}><FieldGroup>
    {creating && draft.action === 'debt.create' ? <Field><FieldLabel htmlFor="debt-name">借贷名称</FieldLabel><Input id="debt-name" value={draft.input.name} maxLength={100} required disabled={disabled} onChange={(event) => patch({ name: event.target.value })} /></Field> : null}
    <div className="editor-grid"><Field><FieldLabel htmlFor="debt-principal">本金金额</FieldLabel><Input id="debt-principal" inputMode="decimal" value={fields.principal ?? ''} required disabled={disabled} onChange={(event) => patch({ principal: event.target.value })} /></Field>
      {draft.action === 'debt.pay' ? <Field><FieldLabel htmlFor="debt-interest">利息金额</FieldLabel><Input id="debt-interest" inputMode="decimal" value={draft.input.interest} required disabled={disabled} onChange={(event) => patch({ interest: event.target.value })} /></Field> : null}</div>
    {split?.overflow ? <p role="status" className="muted-copy">超出本金余额的金额将计为利息：本金 {split.principal}，利息 {split.interest}。</p> : null}
    <Field><FieldLabel>目标账本</FieldLabel><Select value={fields.bookId || undefined} disabled={disabled} onValueChange={(id) => patch({ bookId: id })}><SelectTrigger aria-label="目标账本"><SelectValue placeholder="选择账本" /></SelectTrigger><SelectContent>{options.books.map((book) => <SelectItem key={book.id} value={book.id}>{book.name}</SelectItem>)}</SelectContent></Select></Field>
    <Field><FieldLabel>实际资金资产</FieldLabel><Select value={fields.aboutAssetId ?? '-1'} disabled={disabled} onValueChange={(id) => patch({ aboutAssetId: id === '-1' ? null : id })}><SelectTrigger aria-label="实际资金资产"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="-1">不关联资金资产</SelectItem>{cash.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.name} · {asset.currency}</SelectItem>)}</SelectContent></Select></Field>
    {creating && draft.action === 'debt.create' ? <><div className="editor-grid"><Field><FieldLabel htmlFor="debt-start">开始日期</FieldLabel><Input id="debt-start" type="date" required value={draft.input.startDate} disabled={disabled} onChange={(event) => { if (event.target.value) patch({ startDate: event.target.value }); }} /></Field><Field><FieldLabel htmlFor="debt-end">约定结束日期</FieldLabel><Input id="debt-end" type="date" value={draft.input.endDate ?? ''} disabled={disabled} onChange={(event) => patch({ endDate: event.target.value || null })} /></Field></div><label className="flex items-center gap-3 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={draft.input.inCount} disabled={disabled} onChange={(event) => patch({ inCount: event.target.checked })} />计入资产汇总</label></> : <Field><FieldLabel htmlFor="debt-time">发生时间（上海）</FieldLabel><Input id="debt-time" type="datetime-local" value={timeSec === undefined ? '' : new Date(timeSec * 1000 + 8 * 3600_000).toISOString().slice(0, 16)} required disabled={disabled} onChange={(event) => { const time = Date.parse(`${event.target.value}:00+08:00`); if (Number.isFinite(time)) patch({ timeSec: Math.floor(time / 1000) }); }} /></Field>}
    <Field><FieldLabel htmlFor="debt-remark">操作备注</FieldLabel><Textarea id="debt-remark" value={fields.remark ?? ''} maxLength={500} disabled={disabled} onChange={(event) => patch({ remark: event.target.value })} /></Field>
    {draft.action === 'debt.pay' ? <p className="muted-copy">本金和利息分别保存并跟踪结果；还款后以钱迹返回的余额为准。</p> : null}
    {loaded ? <Attachments references={fields.images ?? []} draftKey={`debt:${draftKey}`} disabled={disabled} onPendingChange={setImagesPending} onChange={async (images) => { const input = draft.action === 'debt.editPrincipal' ? { ...draft.input, changes: { ...draft.input.changes, images } } : { ...draft.input, images }; const next = debtDraftSchema.parse({ ...draft, input }); setDraft(next); return (await persist(next)).status === 'ready'; }} /> : null}
    {error ? <p role="alert">{error}</p> : null}{!loaded && error ? <Button type="button" variant="outline" onClick={() => setLoadAttempt(value => value + 1)}>重新读取草稿</Button> : null}{operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') onComplete(); }} /> : <p className="muted-copy">{saved ? '草稿已保存' : '正在保存草稿…'}</p>}
    {!allowed ? <p className="muted-copy">此写入动作待专用测试资源验收后启用。</p> : null}<Button type="submit" disabled={disabled || !allowed || imagesPending}>{label}</Button>
    {operation && operationIsFinal(operation) ? <Button type="button" variant="outline" disabled={busy} onClick={() => { void renew(); }}>载入最新资料并建立新草稿</Button> : null}
  </FieldGroup></form>;
}
