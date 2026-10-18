import { useState } from 'react';
import type { BillSummary } from '../../features/ledger/contract';
import { useAction } from '../lib/use-action';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Field, FieldLabel } from './ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { DataStatus } from './DataStatus';
import { formatMoney } from './Totals';
export function PlanBillSelect({ type, value, disabled, onChange }: { type: number; value: string; disabled: boolean; onChange(id: string): void }) {
  const [text, setText] = useState(''), [search, setSearch] = useState(''), [cursor, setCursor] = useState<string | undefined>(), [previous, setPrevious] = useState<BillSummary[]>([]), query = useAction('ledger.list', { types: [type], remark: search, limit: 100, ...(cursor ? { cursor } : {}) });
  const items = [...new Map([...previous, ...(query.data?.items ?? [])].map((bill) => [bill.id, bill])).values()];
  return <><Field><FieldLabel htmlFor="plan-bill-search">搜索已有账单备注</FieldLabel><div className="flex gap-2"><Input id="plan-bill-search" value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} /><Button type="button" variant="outline" disabled={disabled} onClick={() => { setSearch(text); setCursor(undefined); setPrevious([]); }}>搜索</Button></div></Field><DataStatus reply={query.reply} retained={!!query.data} /><Field><FieldLabel>已有账单</FieldLabel><Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger aria-label="已有账单"><SelectValue placeholder="选择已有账单" /></SelectTrigger><SelectContent>{items.map((bill) => <SelectItem value={bill.id} key={bill.id}>{bill.remark || '账单'} · {new Date(bill.timeSec * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {formatMoney(bill.money)}</SelectItem>)}</SelectContent></Select></Field>{query.data?.nextCursor ? <Button type="button" variant="outline" disabled={disabled || query.loading || items.length >= 1000} onClick={() => { setPrevious(items); setCursor(query.data!.nextCursor!); }}>载入更多账单</Button> : null}</>;
}
