import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BillDetail } from '../../features/ledger/contract';
import { refundInputSchema, type RefundDraft } from '../../features/ledger/refund-contract';
import type { TransferOptions } from '../../features/ledger/transfer-contract';
import { operationIsFinal, type OperationView } from '../../operations/contract';
import { api } from '../api';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';
import { OperationStatus } from './OperationStatus';
import { formatMoney } from './Totals';

export function RefundEditor({ source, refund, options, onComplete }: { source: BillDetail; refund?: BillDetail; options: TransferOptions | null; onComplete(): void }) {
  const [currentSource, setCurrentSource] = useState(source), [currentRefund, setCurrentRefund] = useState(refund);
  const key = `refund:${source.id}:${refund?.id ?? 'new'}`, base = options?.baseCurrency ?? 'CNY', assets = options?.assets.filter((asset) => ![5, 6].includes(asset.type)) ?? [];
  function currencyFields(fields: RefundDraft['fields'], sourceBill = currentSource): RefundDraft['fields'] {
    const sourceSymbol = sourceBill.currency?.srcSymbol ?? base, targetSymbol = assets.find((asset) => asset.id === fields.assetId)?.currency ?? base;
    if (!sourceBill.currency && targetSymbol === base) { const { currency: _old, ...rest } = fields; return rest; }
    const previous = fields.currency, money = fields.money ?? '';
    return { ...fields, currency: { srcSymbol: sourceSymbol, srcValue: money, targetSymbol,
      targetValue: targetSymbol === sourceSymbol ? money : previous?.targetSymbol === targetSymbol ? previous.targetValue : '',
      baseSymbol: base, baseValue: sourceSymbol === base ? money : previous?.baseValue ?? '' } };
  }
  function initial(sourceBill = currentSource, refundBill = currentRefund): RefundDraft {
    const currency = refundBill?.currency;
    const fields: RefundDraft['fields'] = currencyFields({ money: currency?.srcValue ?? refundBill?.money ?? '', timeSec: refundBill?.timeSec ?? Math.floor(Date.now() / 1000),
      assetId: refundBill?.assetId && /^[1-9]\d*$/.test(refundBill.assetId) ? refundBill.assetId : null, remark: refundBill?.remark ?? '',
      ...(refundBill?.images.length ? { images: refundBill.images } : {}), ...(refundBill?.tagIds.length ? { tagIds: refundBill.tagIds } : {}),
      ...(currency?.srcSymbol && currency.targetSymbol && currency.baseSymbol ? { currency: { ...currency, srcSymbol: currency.srcSymbol, targetSymbol: currency.targetSymbol, baseSymbol: currency.baseSymbol } } : {}) }, sourceBill);
    return { kind: 'refund', requestId: crypto.randomUUID(), billId: sourceBill.id, expectedVersion: sourceBill.editVersion ?? '', fields,
      ...(refundBill ? { refundBillId: refundBill.id, refundExpectedVersion: refundBill.editVersion } : {}) };
  }
  const [draft, setDraft] = useState<RefundDraft>(initial), [loaded, setLoaded] = useState(false), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationView | null>(null), [operationId, setOperationId] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true);
  const persist = (value: RefundDraft) => {
    const task = queue.current.then(() => api('ledger.draft.save', { key, draft: value })); queue.current = task;
    return task.then((reply) => { if (mounted.current) { setSaved(reply.status === 'ready'); if (reply.error) setError(reply.error.message); } return reply; });
  };
  useEffect(() => {
    let active = true; mounted.current = true;
    void api('ledger.draft.get', { key }).then((reply) => {
      if (!active) return;
      if (reply.data?.draft.kind === 'refund') { setDraft(reply.data.draft); setOperationId(reply.data.operationId); setSaved(true); }
      else if (reply.error) setError(reply.error.message);
      setLoaded(true);
    });
    return () => { active = false; mounted.current = false; };
  }, [key]);
  useEffect(() => { if (!loaded || operationId || busy) return; const timer = setTimeout(() => { void persist(draft); }, 400); return () => clearTimeout(timer); }, [draft, loaded, operationId, busy]);
  function change(fields: Partial<RefundDraft['fields']>) {
    let next = { ...draft.fields, ...fields };
    if (Object.hasOwn(fields, 'money') || Object.hasOwn(fields, 'assetId')) next = currencyFields(next);
    setDraft({ ...draft, fields: next }); setSaved(false); setError(null); setNotice(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || operationId || !loaded) return;
    const value = { ...draft.fields, money: draft.fields.money?.trim() || undefined, billId: draft.billId, expectedVersion: draft.expectedVersion,
      ...(draft.refundBillId ? { refundBillId: draft.refundBillId, refundExpectedVersion: draft.refundExpectedVersion } : {}) };
    const parsed = refundInputSchema.safeParse(value); if (!parsed.success) { setError('请核对退款时间、金额和历史币种资料。'); return; }
    setBusy(true); setError(null);
    try {
      if ((await persist(draft)).status !== 'ready') return;
      const reply = await api('ledger.refund', { ...parsed.data, requestId: draft.requestId });
      if (reply.data) { setOperation(reply.data); setOperationId(reply.data.id); if (reply.data.state === 'succeeded') onComplete(); }
      else { const recovery = await api('ledger.draft.get', { key }); setOperationId(recovery.data?.operationId ?? null); setError(reply.error?.message ?? '未取得操作结果，请保留草稿并核查原操作。'); }
    } finally { setBusy(false); }
  }
  async function nextDraft() {
    if (!operation || !operationIsFinal(operation)) return;
    setBusy(true);
    try {
      const nextSource = await api('ledger.detail', { id: source.id });
      if (!nextSource.data?.editVersion) { setError(nextSource.error?.message ?? '请先载入最新源账单'); return; }
      const nextRefund = currentRefund ? await api('ledger.detail', { id: currentRefund.id }) : null;
      if (currentRefund && !nextRefund?.data?.editVersion) { setError(nextRefund?.error?.message ?? '退款记录尚未载入'); return; }
      setCurrentSource(nextSource.data); setCurrentRefund(nextRefund?.data ?? undefined);
      const next = initial(nextSource.data, nextRefund?.data ?? undefined);
      if (operation.state === 'failed') next.fields = draft.fields;
      setDraft(next); setOperationId(null); setOperation(null); setSaved(false); setError(null); setNotice('已载入最新资料，请核对草稿后再保存。');
    } finally { setBusy(false); }
  }
  const disabled = !loaded || busy || !!operationId, currency = draft.fields.currency;
  const time = draft.fields.timeSec === undefined ? '' : new Date(draft.fields.timeSec * 1000 - new Date(draft.fields.timeSec * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return <form className="bill-editor" onSubmit={(event) => { void submit(event); }}><FieldGroup>
    <div className="operation-status"><strong>源账单 · {currentSource.remark || currentSource.id}</strong><p className="muted-copy">{formatMoney(currentSource.currency?.srcValue ?? currentSource.money)} {currentSource.currency?.srcSymbol ?? base} · {new Date(currentSource.timeSec * 1000).toLocaleDateString('zh-CN')}</p><p className="muted-copy">退款会更新源账单所属期间的收支统计。</p></div>
    <div className="editor-grid"><Field><FieldLabel htmlFor="refund-money">退款金额</FieldLabel><Input id="refund-money" inputMode="decimal" value={draft.fields.money ?? ''} placeholder={currentRefund ? '本次退款金额' : '留空退剩余金额'} disabled={disabled} onChange={(event) => change({ money: event.target.value })} /></Field>
    <Field><FieldLabel>到账资产</FieldLabel><Select value={draft.fields.assetId ?? '-1'} disabled={disabled} onValueChange={(id) => change({ assetId: id === '-1' ? null : id })}><SelectTrigger aria-label="退款到账资产"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="-1">不关联资产</SelectItem>{assets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.name} · {asset.currency}</SelectItem>)}</SelectContent></Select></Field>
    <Field className="col-span-full"><FieldLabel htmlFor="refund-time">退款时间</FieldLabel><Input id="refund-time" type="datetime-local" value={time} disabled={disabled} required onChange={(event) => { const ms = new Date(event.target.value).getTime(); if (Number.isFinite(ms)) change({ timeSec: Math.floor(ms / 1000) }); }} /></Field></div>
    {currency ? <div className="editor-grid"><Field><FieldLabel htmlFor="refund-target">历史到账金额（{currency.targetSymbol}）</FieldLabel><Input id="refund-target" inputMode="decimal" value={currency.targetValue} disabled={disabled || currency.targetSymbol === currency.srcSymbol} onChange={(event) => change({ currency: { ...currency, targetValue: event.target.value } })} required /></Field><Field><FieldLabel htmlFor="refund-base">历史本位币金额（{base}）</FieldLabel><Input id="refund-base" inputMode="decimal" value={currency.baseValue} disabled={disabled || currency.srcSymbol === base} onChange={(event) => change({ currency: { ...currency, baseValue: event.target.value } })} required /></Field></div> : null}
    <Field><FieldLabel htmlFor="refund-remark">退款备注</FieldLabel><Textarea id="refund-remark" value={draft.fields.remark ?? ''} maxLength={500} disabled={disabled} onChange={(event) => change({ remark: event.target.value })} /></Field>
    {notice ? <p role="status" className="muted-copy">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
    {operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') onComplete(); }} /> : <p className="muted-copy">{saved ? '草稿已保存' : '正在保存草稿…'}</p>}
    <Button type="submit" disabled={disabled}>{busy ? '正在处理…' : '保存退款'}</Button>
    {operation && operationIsFinal(operation) ? <Button type="button" variant="outline" disabled={busy} onClick={() => { void nextDraft(); }}>载入最新资料并建立新草稿</Button> : null}
  </FieldGroup></form>;
}
