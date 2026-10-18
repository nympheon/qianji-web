import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BillDetail } from '../../features/ledger/contract';
import { transferInputSchema, type TransferDraft, type TransferInput, type TransferOptions, type TransferPreview } from '../../features/ledger/transfer-contract';
import type { OperationView } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import { addMoney } from '../../shared/numbers';
import { api } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';
import { OperationStatus } from './OperationStatus';
import { formatMoney } from './Totals';

export function TransferEditor({ kind, mode = 'create', options, bill, onComplete }: { kind: 'transfer' | 'repay-card'; mode?: 'create' | 'edit' | 'delete'; options: TransferOptions | null; bill?: BillDetail; onComplete(): void }) {
  const key = `${kind}:${mode}:${bill?.id ?? 'new'}`, base = options?.baseCurrency ?? 'CNY', eligible = options?.assets.filter((asset) => asset.type !== 5 && asset.type !== 6) ?? [];
  function currencyFields(fields: TransferDraft['fields']): TransferDraft['fields'] {
    const from = eligible.find((asset) => asset.id === fields.fromAssetId), target = eligible.find((asset) => asset.id === fields.targetAssetId);
    if (!from || !target) return fields;
    if (from.currency === base && target.currency === base) return { ...fields, currency: null };
    const previous = fields.currency, entered = fields.enteredMoney ?? '';
    return { ...fields, currency: { srcSymbol: from.currency, srcValue: entered, targetSymbol: target.currency,
      targetValue: from.currency === target.currency ? entered : previous?.srcSymbol === from.currency && previous?.targetSymbol === target.currency ? previous.targetValue : '',
      baseSymbol: base, baseValue: from.currency === base ? entered : previous?.baseValue ?? '' } };
  }
  const initial = (): TransferDraft => {
    const from = eligible[0], target = (kind === 'repay-card' ? eligible.find((asset) => asset.type === 2 && asset.id !== from?.id) : null) ?? eligible.find((asset) => asset.id !== from?.id);
    const fields: TransferDraft['fields'] = bill ? { bookId: bill.bookId, fromAssetId: bill.fromId ?? undefined, targetAssetId: bill.targetId ?? undefined,
      enteredMoney: bill.currency?.srcValue ?? addMoney(bill.money, bill.transferFee.startsWith('-') ? bill.transferFee.slice(1) : bill.transferFee), fee: bill.transferFee,
      timeSec: bill.timeSec, remark: bill.remark, tagIds: bill.tagIds, countInStatistics: !(bill.flags & 1), countInBudget: !(bill.flags & 2),
      ...(bill.currency?.srcSymbol && bill.currency.targetSymbol && bill.currency.baseSymbol ? { currency: { ...bill.currency, srcSymbol: bill.currency.srcSymbol, targetSymbol: bill.currency.targetSymbol, baseSymbol: bill.currency.baseSymbol } } : {}) }
      : currencyFields({ bookId: options?.books[0]?.id, fromAssetId: from?.id, targetAssetId: target?.id, enteredMoney: '', fee: '0', timeSec: Math.floor(Date.now() / 1000), remark: '' });
    return { kind, mode, requestId: crypto.randomUUID(), fields, ...(bill ? { billId: bill.id, expectedVersion: bill.editVersion } : {}) };
  };
  const [draft, setDraft] = useState<TransferDraft>(initial), [loaded, setLoaded] = useState(false), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TransferPreview | null>(null), [operationId, setOperationId] = useState<string | null>(null), [operation, setOperation] = useState<OperationView | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), baseline = useRef(draft.fields), mounted = useRef(true);
  const persist = (value: TransferDraft) => {
    const task = queue.current.then(() => api('ledger.draft.save', { key, draft: value })); queue.current = task;
    return task.then((reply) => { if (mounted.current) { setSaved(reply.status === 'ready'); if (reply.error) setError(reply.error.message); } return reply; });
  };
  useEffect(() => {
    let active = true; mounted.current = true;
    void api('ledger.draft.get', { key }).then((reply) => {
      if (!active) return;
      if (reply.data && (reply.data.draft.kind === 'transfer' || reply.data.draft.kind === 'repay-card')) { setDraft(reply.data.draft); setOperationId(reply.data.operationId); setSaved(true); }
      else if (reply.error) setError(reply.error.message);
      setLoaded(true);
    });
    return () => { active = false; mounted.current = false; };
  }, [key]);
  useEffect(() => { if (!loaded || operationId || busy) return; const timer = setTimeout(() => { void persist(draft); }, 400); return () => clearTimeout(timer); }, [draft, loaded, operationId, busy]);
  function change(fields: Partial<TransferDraft['fields']>) {
    let next = { ...draft.fields, ...fields };
    if (['fromAssetId', 'targetAssetId', 'enteredMoney'].some((field) => Object.hasOwn(fields, field))) next = currencyFields(next);
    setDraft({ ...draft, fields: next }); setPreview(null); setSaved(false); setError(null);
  }
  function input(): TransferInput | null {
    const changes = Object.fromEntries(Object.entries(draft.fields).filter(([name, value]) => JSON.stringify(baseline.current[name as keyof TransferDraft['fields']]) !== JSON.stringify(value)));
    const value = draft.mode === 'create' ? { mode: 'create', ...draft.fields } : draft.mode === 'delete' ? { mode: 'delete', id: draft.billId, expectedVersion: draft.expectedVersion } : { mode: 'edit', id: draft.billId, expectedVersion: draft.expectedVersion, changes };
    const parsed = transferInputSchema.safeParse(value);
    if (!parsed.success) { setError(draft.mode === 'edit' && !Object.keys(changes).length ? '尚未修改记录。' : '请完整填写两侧资产、金额和历史币种金额。'); return null; }
    return parsed.data;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || operationId || !loaded) return;
    const value = input(); if (!value) return;
    setBusy(true); setError(null);
    try {
      if ((await persist(draft)).status !== 'ready') return;
      const reply = await api(kind === 'transfer' ? 'ledger.transfer' : 'ledger.repayCard', { ...value, requestId: draft.requestId });
      if (reply.data) { setOperation(reply.data); setOperationId(reply.data.id); if (reply.data.state === 'succeeded') onComplete(); }
      else { const recovery = await api('ledger.draft.get', { key }); setOperationId(recovery.data?.operationId ?? null); setError(reply.error?.message ?? '未取得操作结果，请保留草稿并核查原操作。'); }
    } finally { setBusy(false); }
  }
  const disabled = !loaded || busy || !!operationId, deleting = mode === 'delete';
  const currency = draft.fields.currency, source = eligible.find((asset) => asset.id === draft.fields.fromAssetId), target = eligible.find((asset) => asset.id === draft.fields.targetAssetId);
  const date = draft.fields.timeSec === undefined ? '' : new Date(draft.fields.timeSec * 1000 - new Date(draft.fields.timeSec * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return <form className="bill-editor" onSubmit={(event) => { void submit(event); }}><FieldGroup>
    <div className="editor-grid"><Field><FieldLabel>转出资产</FieldLabel><Select value={draft.fields.fromAssetId ?? ''} disabled={disabled || deleting} onValueChange={(fromAssetId) => change({ fromAssetId })}><SelectTrigger aria-label="转出资产"><SelectValue placeholder="选择资产" /></SelectTrigger><SelectContent>{eligible.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.name} · {asset.currency}</SelectItem>)}</SelectContent></Select></Field>
    <Field><FieldLabel>转入资产</FieldLabel><Select value={draft.fields.targetAssetId ?? ''} disabled={disabled || deleting} onValueChange={(targetAssetId) => change({ targetAssetId })}><SelectTrigger aria-label="转入资产"><SelectValue placeholder="选择资产" /></SelectTrigger><SelectContent>{eligible.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.name} · {asset.currency}</SelectItem>)}</SelectContent></Select></Field>
    <Field><FieldLabel htmlFor="transfer-entered">录入金额</FieldLabel><Input id="transfer-entered" inputMode="decimal" value={draft.fields.enteredMoney ?? ''} disabled={disabled || deleting} onChange={(event) => change({ enteredMoney: event.target.value })} required /></Field>
    <Field><FieldLabel htmlFor="transfer-fee">手续费 / 优惠</FieldLabel><Input id="transfer-fee" inputMode="decimal" value={draft.fields.fee ?? '0'} disabled={disabled || deleting} onChange={(event) => change({ fee: event.target.value })} /></Field>
    <Field><FieldLabel>账本</FieldLabel><Select value={draft.fields.bookId ?? ''} disabled={disabled || deleting} onValueChange={(bookId) => change({ bookId })}><SelectTrigger aria-label="转账账本"><SelectValue placeholder="选择账本" /></SelectTrigger><SelectContent>{options?.books.map((book) => <SelectItem key={book.id} value={book.id}>{book.name}</SelectItem>)}</SelectContent></Select></Field>
    <Field><FieldLabel htmlFor="transfer-time">时间</FieldLabel><Input id="transfer-time" type="datetime-local" value={date} disabled={disabled || deleting} onChange={(event) => { const ms = new Date(event.target.value).getTime(); if (Number.isFinite(ms)) change({ timeSec: Math.floor(ms / 1000) }); }} required /></Field></div>
    <p className="muted-copy">正数为手续费，负数为优惠。保存前可预览本金和两侧金额。</p>
    {currency ? <div className="editor-grid"><Field><FieldLabel htmlFor="transfer-currency-target">历史转入金额（{currency.targetSymbol}）</FieldLabel><Input id="transfer-currency-target" inputMode="decimal" value={currency.targetValue} disabled={disabled || deleting || source?.currency === target?.currency} onChange={(event) => change({ currency: { ...currency, targetValue: event.target.value } })} required /></Field><Field><FieldLabel htmlFor="transfer-currency-base">历史本位币金额（{base}）</FieldLabel><Input id="transfer-currency-base" inputMode="decimal" value={currency.baseValue} disabled={disabled || deleting || source?.currency === base} onChange={(event) => change({ currency: { ...currency, baseValue: event.target.value } })} required /></Field><p className="muted-copy col-span-full">填写本次记录采用的历史金额；本位币金额按扣手续费前的录入额换算。同币种转入额会按费用自动校正。</p></div> : null}
    <Field><FieldLabel htmlFor="transfer-remark">备注</FieldLabel><Textarea id="transfer-remark" value={draft.fields.remark ?? ''} disabled={disabled || deleting} maxLength={500} onChange={(event) => change({ remark: event.target.value })} /></Field>
    <Button type="button" variant="outline" disabled={disabled} onClick={async () => { const value = input(); if (!value) return; setBusy(true); try { const reply = await api('ledger.transfer.preview', { kind, input: value }); setPreview(reply.data); setError(reply.error?.message ?? null); } finally { setBusy(false); } }}>预览金额</Button>
    {preview ? <div className="operation-status"><dl className="transfer-amounts"><dt>本金</dt><dd data-testid="transfer-principal">{formatMoney(preview.principal)} {preview.from.currency}</dd><dt>转出金额</dt><dd data-testid="transfer-from">{formatMoney(preview.fromAmount)} {preview.from.currency}</dd><dt>转入金额</dt><dd data-testid="transfer-target">{formatMoney(preview.targetAmount)} {preview.target.currency}</dd></dl><p className="muted-copy">资产变动为预期值，确认余额以钱迹回读为准。{preview.stale ? '当前预览采用缓存资料。' : ''}</p></div> : null}
    {error ? <p role="alert">{error}</p> : null}{operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') onComplete(); }} /> : <p className="muted-copy">{saved ? '草稿已保存' : '正在保存草稿…'}</p>}
    <Button type="submit" variant={deleting ? 'destructive' : 'default'} disabled={disabled}>{busy ? '正在处理…' : deleting ? '确认删除记录' : kind === 'repay-card' ? '保存还款' : '保存转账'}</Button>
    {mode === 'create' && operation && operationIsFinal(operation) ? <Button type="button" variant="outline" onClick={() => { const next = initial(); baseline.current = next.fields; setDraft(next); setOperation(null); setOperationId(null); setPreview(null); setError(null); setSaved(false); }}>建立新草稿</Button> : null}
  </FieldGroup></form>;
}
