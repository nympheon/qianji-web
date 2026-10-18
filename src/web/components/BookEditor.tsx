import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bookDraftSchema, bookWriteSchemas, type BookDraft, type BookTypesView, type BookDeleteCheckView, type BookView } from '../../features/books/contract';
import type { OperationView } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import { api } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { OperationStatus } from './OperationStatus';
import { Attachments } from './Attachments';
export function BookRangeSelect({ value, disabled, onChange }: { value: string; disabled: boolean; onChange(value: string): void }) {
  return <Field><FieldLabel>账本业务周期</FieldLabel><Select value={value === '' || value === 'm1' ? 'month' : value} disabled={disabled} onValueChange={(range) => onChange(range === 'month' ? '' : range)}><SelectTrigger aria-label="账本业务周期"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="month">自然月</SelectItem>{Array.from({ length: 27 }, (_, index) => index + 2).map((day) => <SelectItem key={day} value={`m${day}`}>每月 {day} 日起</SelectItem>)}<SelectItem value="q">季度</SelectItem><SelectItem value="y">全年</SelectItem><SelectItem value="all">全部时间</SelectItem></SelectContent></Select></Field>;
}
export function BookEditor({ initial, draftKey, allowed, types, deletion, books, onComplete }: { initial: BookDraft; draftKey: string; allowed: boolean; types?: BookTypesView; deletion?: BookDeleteCheckView; books?: BookView[]; onComplete(): void }) {
  const [draft, setDraft] = useState(initial), [loaded, setLoaded] = useState(false), [loadAttempt, setLoadAttempt] = useState(0), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [operationId, setOperationId] = useState<string | null>(null), [operation, setOperation] = useState<OperationView | null>(null);
  const [imagesPending, setImagesPending] = useState(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true);
  const persist = (value: BookDraft) => { const task = queue.current.then(() => api('books.draft.save', { key: draftKey, draft: value })); queue.current = task; return task.then((reply) => { if (mounted.current) { setSaved(reply.status === 'ready'); if (reply.error) setError(reply.error.message); } return reply; }); };
  useEffect(() => { let active = true; mounted.current = true; setLoaded(false); void api('books.draft.get', { key: draftKey }).then((reply) => { if (!active) return; if (reply.data) { if (reply.data.draft.action !== initial.action) { setError('原草稿类型不匹配，请保留原操作'); return; } setDraft(reply.data.draft); setOperationId(reply.data.operationId); setSaved(true); } setError(reply.error?.message ?? null); setLoaded(reply.status === 'ready' && !reply.error); }); return () => { active = false; mounted.current = false; }; }, [draftKey,loadAttempt]);
  useEffect(() => { if (!loaded || busy || operationId) return; const timer = setTimeout(() => { void persist(draft); }, 400); return () => clearTimeout(timer); }, [draft, loaded, busy, operationId]);
  function patch(value: Record<string, unknown>) { const next = bookDraftSchema.safeParse({ ...draft, input: { ...draft.input, ...value } }); if (!next.success) { setError('请核对输入范围'); return; } setDraft(next.data); setSaved(false); setError(null); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!loaded || busy || operationId || !allowed || deletion?.blocked || (draft.action === 'books.submit' && imagesPending)) return;
    const parsed = bookWriteSchemas[draft.action].safeParse(draft.input); if (!parsed.success) { setError('请完整填写本次操作所需的名称与配置'); return; }
    setBusy(true); setError(null);
    try {
      if ((await persist(draft)).status !== 'ready') return;
      const reply = await api(draft.action, { ...parsed.data, requestId: draft.requestId });
      if (reply.data) { setOperation(reply.data); setOperationId(reply.data.id); if (reply.data.state === 'succeeded') onComplete(); }
      else { const recovery = await api('books.draft.get', { key: draftKey }); setOperationId(recovery.data?.operationId ?? null); setError(reply.error?.message ?? '请保留草稿并核查原操作'); }
    } finally { setBusy(false); }
  }
  async function renew() {
    if (!operation || !operationIsFinal(operation)) return; setBusy(true);
    try {
      let input: unknown = draft.input;
      if (draft.action === 'books.setBaseCurrency') { const reply = await api('books.accounting', {}); if (!reply.data) { setError(reply.error?.message ?? '请先刷新本位币配置'); return; } input = { ...draft.input, expectedVersion: reply.data.editVersion }; }
      else if ('expectedVersion' in draft.input && 'id' in draft.input) {
        const id = draft.input.id, reply = await api('books.list', { includeHidden: true }), book = reply.data?.items.find((book) => book.id === id);
        if (!book) { setError(reply.error?.message ?? '账本已不可访问，请关闭后重新选择'); return; } input = { ...draft.input, expectedVersion: book.editVersion };
      } else if (draft.action === 'books.submit' && draft.input.mode === 'create') input = initial.input;
      setDraft(bookDraftSchema.parse({ ...draft, input, requestId: crypto.randomUUID() })); setOperationId(null); setOperation(null); setSaved(false); setError(null);
    } finally { setBusy(false); }
  }
  const disabled = !loaded || busy || !!operationId;
  const labels: Record<BookDraft['action'], string> = { 'books.submit': '保存账本', 'books.configure': '保存业务周期', 'books.setVisible': '确认账本显隐', 'books.delete': '确认删除云端账本', 'books.quit': '确认退出或移除成员', 'books.reorder': '保存账本顺序', 'books.setBaseCurrency': '保存本位币' };
  return <form className="bill-editor" onSubmit={(event) => { void submit(event); }}><FieldGroup>
    {draft.action === 'books.submit' ? <>
      {draft.input.mode === 'create' ? <Field><FieldLabel>账本类型</FieldLabel><Select value={String(draft.input.type)} disabled={disabled} onValueChange={(value) => { const type = types?.items.find((type) => String(type.type) === value); if (type) patch({ type: type.type, cover: type.cover, range: type.range }); }}><SelectTrigger aria-label="账本类型"><SelectValue /></SelectTrigger><SelectContent>{types?.items.map((type) => <SelectItem key={type.type} value={String(type.type)}>{type.name}</SelectItem>)}</SelectContent></Select></Field> : null}
      <Field><FieldLabel htmlFor="book-name">账本名称</FieldLabel><Input id="book-name" value={draft.input.name ?? ''} maxLength={100} required disabled={disabled} onChange={(event) => patch({ name: event.target.value })} /></Field>
      {draft.input.mode === 'create' ? <BookRangeSelect value={draft.input.range ?? ''} disabled={disabled} onChange={(range) => patch({ range })} /> : null}
    </> : null}
    {draft.action === 'books.configure' ? <BookRangeSelect value={draft.input.range} disabled={disabled} onChange={(range) => patch({ range })} /> : null}
    {draft.action === 'books.setBaseCurrency' ? <><Field><FieldLabel htmlFor="book-base-currency">本位币</FieldLabel><Input id="book-base-currency" value={draft.input.baseCurrency} maxLength={20} required disabled={disabled} onChange={(event) => patch({ baseCurrency: event.target.value.toUpperCase() })} /></Field><p className="muted-copy">将更新钱迹账号本位币，并重新计算相关统计与资产汇总。</p></> : null}
    {draft.action === 'books.setVisible' ? <p>将此账本设为{draft.input.visible ? '显示' : '隐藏'}；保存前会读取最新状态。</p> : null}
    {draft.action === 'books.delete' ? <div className="operation-status"><strong>云端账本及其中账单将被删除</strong>{deletion ? <><p>{deletion.ownerHasUnresolved ? '所有者仍有未结事项' : '所有者没有未结事项'}</p><p>{deletion.memberHasUnresolved ? '成员仍有未结事项' : '成员没有未结事项'}</p>{deletion.blocked ? <p role="alert">请先处理未结事项，再删除账本。</p> : null}</> : <p>需要先完成官方删除检查。</p>}</div> : null}
    {draft.action === 'books.quit' ? <p>退出本人参与的账本时保留所有者的云端账本；移除成员使用所选真实成员ID。</p> : null}
    {draft.action === 'books.reorder' ? <div className="flex flex-col gap-2">{draft.input.ids.map((id, index) => <div className="flex items-center justify-between gap-3 rounded-lg border p-3" key={id}><span>{books?.find((book) => book.id === id)?.name ?? id}</span><div className="flex gap-1">{[-1, 1].map((step) => <Button key={step} size="sm" variant="outline" type="button" disabled={disabled || index + step < 0 || index + step >= draft.input.ids.length} onClick={() => { if (draft.action !== 'books.reorder') return; const ids = [...draft.input.ids]; [ids[index], ids[index + step]] = [ids[index + step]!, ids[index]!]; patch({ ids }); }}>{step < 0 ? '上移' : '下移'}</Button>)}</div></div>)}</div> : null}
    {loaded && draft.action === 'books.submit' ? <Attachments references={draft.input.cover ? [draft.input.cover] : []} purpose="cover" draftKey={`books:${draftKey}`} disabled={disabled} onPendingChange={setImagesPending} onChange={async (images) => { const next = bookDraftSchema.parse({ ...draft, input: { ...draft.input, cover: images[0] ?? null } }); setDraft(next); return (await persist(next)).status === 'ready'; }} /> : null}
    {error ? <p role="alert">{error}</p> : null}{!loaded && error ? <Button type="button" variant="outline" onClick={() => setLoadAttempt(value => value + 1)}>重新读取草稿</Button> : null}{operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') onComplete(); }} /> : <p className="muted-copy">{saved ? '草稿已保存' : '正在保存草稿…'}</p>}
    {!allowed ? <p className="muted-copy">此写入动作待专用测试账本验收后启用。</p> : null}<Button type="submit" variant={draft.action === 'books.delete' || draft.action === 'books.quit' ? 'destructive' : 'default'} disabled={disabled || (draft.action === 'books.submit' && imagesPending) || !allowed || !!deletion?.blocked || draft.action === 'books.delete' && !deletion}>{labels[draft.action]}</Button>
    {operation && operationIsFinal(operation) ? <Button type="button" variant="outline" disabled={busy} onClick={() => { void renew(); }}>载入最新资料并建立新草稿</Button> : null}
  </FieldGroup></form>;
}
