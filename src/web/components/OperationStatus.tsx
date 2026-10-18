import { useEffect, useState } from 'react';
import type { OperationView } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import { api } from '../api';
import { Button } from './ui/button';
const labels: Record<OperationView['state'], string> = { queued: '操作已排队', sending: '正在保存', verifying: '正在核查', succeeded: '操作已完成', failed: '操作未成功', uncertain: '结果待核查', partial: '部分项目已完成' };
export function OperationStatus({ operationId, initial, onChange }: { operationId: string; initial?: OperationView | null; onChange?: (operation: OperationView) => void }) {
  const [operation, setOperation] = useState(initial ?? null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0;
    const read = async () => {
      if (disposed || document.hidden) return;
      const reply = await api('operations.get', { operationId });
      if (disposed) return;
      if (reply.data) { setOperation(reply.data); onChange?.(reply.data); }
      if (reply.error) setError(reply.error.message);
      if (reply.data && ['queued', 'sending', 'verifying'].includes(reply.data.state) && ++attempts < 60) timer = setTimeout(() => { void read(); }, 2000);
    };
    const visible = () => { if (!document.hidden && !disposed) { clearTimeout(timer); void read(); } };
    if (!initial || ['queued', 'sending', 'verifying'].includes(initial.state)) void read();
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [operationId]);
  return <div className="operation-status" role="status"><strong>{operation ? labels[operation.state] : '正在读取原操作'}</strong><p className="muted-copy">操作 ID：<code>{operationId}</code></p>{operation?.items.length ? <details><summary>{operation.items.filter((item) => item.state === 'succeeded').length} / {operation.items.length} 项已确认 · 逐项结果</summary><ul className="operation-items">{operation.items.map((item) => <li key={item.id}><code>{item.id.startsWith('asset-ledger:') ? '资产关联账单核查' : item.id.startsWith('asset-group:') ? '资产分组操作' : item.id.startsWith('asset:') ? '资产操作' : item.id.startsWith('relations:') ? `源账单关系核查 · ${item.id.slice(10)}` : item.id.startsWith('refund:') ? '新增退款' : item.id}</code><span>{item.state === 'succeeded' ? '已确认' : item.state === 'failed' ? '未成功' : '待确认'}</span>{item.error ? <p>{item.error.message}</p> : null}{item.assetEffects?.length ? <div><p className="muted-copy">预期资产变动（以已缓存余额估算）</p>{item.assetEffects.map((effect) => <p key={effect.assetId}>{effect.assetId}：{effect.delta} {effect.currency}，预期余额 {effect.expectedBalance}{effect.expectedLastPayTimeSec ? `；最新还款日期预期 ${new Date(Number(effect.expectedLastPayTimeSec) * 1000).toLocaleDateString('zh-CN')}` : ''}</p>)}</div> : null}</li>)}</ul></details> : null}{operation?.error || error ? <p role="alert">{operation?.error?.message ?? error}</p> : null}{operation && !operationIsFinal(operation) && (operation.state === 'uncertain' || operation.state === 'partial') ? <><p className="muted-copy">保留原操作，核查完成前无需再次记账。</p><Button type="button" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { const reply = await api('operations.reconcile', { operationId }); if (reply.data) { setOperation(reply.data); onChange?.(reply.data); } setError(reply.error?.message ?? null); } finally { setBusy(false); } }}>核查原操作</Button></> : null}</div>;
}
