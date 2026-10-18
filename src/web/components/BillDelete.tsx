import { useEffect, useState } from 'react';
import type { BillDetail } from '../../features/ledger/contract';
import type { BillDraft } from '../../features/ledger/write-contract';
import type { OperationView } from '../../operations/contract';
import { api } from '../api';
import { Button } from './ui/button';
import { OperationStatus } from './OperationStatus';
export function BillDelete({ bill, onComplete }: { bill: BillDetail; onComplete(): void }) {
  const key = `delete:${bill.id}`;
  const [draft, setDraft] = useState<BillDraft | null>(null), [loadAttempt,setLoadAttempt] = useState(0), [operationId, setOperationId] = useState<string | null>(null), [operation, setOperation] = useState<OperationView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; setDraft(null); void api('ledger.draft.get', { key }).then((reply) => {
    if (!active) return;
    if (reply.error || reply.status !== 'ready') { setError(reply.error?.message ?? '原草稿尚未读取，请重试'); return; }
    const saved = reply.data?.draft;
    if (saved && (saved.kind !== 'edit' || saved.billId !== bill.id)) { setError('原草稿类型不匹配，请保留原操作'); return; }
    setDraft(saved && (saved.kind === 'create' || saved.kind === 'edit') ? saved : { kind: 'edit', requestId: crypto.randomUUID(), fields: {}, billId: bill.id, expectedVersion: bill.editVersion });
    setOperationId(reply.data?.operationId ?? null); setError(null);
  }); return () => { active = false; }; }, [key,loadAttempt]);
  return <div className="flex flex-col gap-4"><p>删除后将同步到钱迹。请核对这笔账单及关联记录。</p><p>{bill.remark || bill.id}</p>{error ? <p role="alert">{error}</p> : null}{operationId ? <OperationStatus operationId={operationId} initial={operation} onChange={(value) => { setOperation(value); if (value.state === 'succeeded') onComplete(); }} /> : null}<Button variant="destructive" disabled={busy || !draft || !!operationId || !draft.expectedVersion} onClick={async () => {
    if (!draft || !draft.expectedVersion) return; setBusy(true);
    try {
      const saved = await api('ledger.draft.save', { key, draft }); if (saved.status !== 'ready') { setError(saved.error?.message ?? '草稿未保存'); return; }
      const reply = await api('ledger.delete', { requestId: draft.requestId, bills: [{ id: bill.id, expectedVersion: draft.expectedVersion }] });
      if (reply.data) { setOperationId(reply.data.id); setOperation(reply.data); if (reply.data.state === 'succeeded') onComplete(); }
      else { const recovery = await api('ledger.draft.get', { key }); setOperationId(recovery.data?.operationId ?? null); setError(reply.error?.message ?? '未取得操作结果，请核查原操作'); }
    } finally { setBusy(false); }
  }}>确认删除这笔账单</Button>{!draft && error ? <Button type="button" variant="outline" onClick={() => setLoadAttempt(value => value + 1)}>重新读取草稿</Button> : null}</div>;
}
