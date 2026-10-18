import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import type { ConnectionView } from '../../features/connection/contract';
import type { AppReply } from '../../shared/reply';
import type { RouteId } from '../../protocol/profile';
import { api } from '../api';
import { useAction } from '../lib/use-action';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { Button } from '../components/ui/button';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export function ServicePage({ current, onConnection }: { current: ConnectionView | null; onConnection: (view: ConnectionView) => void }) {
  const [result, setResult] = useState<AppReply<unknown> | null>(null), [busy, setBusy] = useState(false), [route, setRoute] = useState<RouteId>(current?.route ?? 'main'), [copied, setCopied] = useState(false);
  const capabilities = useAction('capabilities.list', {});
  async function connectionAction(action: 'connection.check' | 'connection.logout' | 'connection.selectRoute') {
    setBusy(true); try { const reply = action === 'connection.selectRoute' ? await api(action, { route }) : await api(action, {}); setResult(reply); if (reply.data) onConnection(reply.data); } finally { setBusy(false); }
  }
  async function sync(domain: 'ledger' | 'tags', mode: 'incremental' | 'rebuild') { setBusy(true); try { setResult(await api('sync.start', { domain, mode })); } finally { setBusy(false); } }
  return <div className="page-stack"><section className="content-section"><h2>钱迹连接</h2><dl className="service-details"><dt>状态</dt><dd>{current?.state === 'connected' ? '已连接' : current?.state === 'needs_login' ? '需要重新登录' : '未连接'}</dd><dt>账号</dt><dd>{current?.user?.name || '—'}</dd><dt>最近检查</dt><dd>{current?.lastCheckedAt ? new Date(current.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查'}</dd></dl><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { void connectionAction('connection.check'); }}>检查登录状态</Button><Button variant="outline" asChild><a href="/connection">重新登录</a></Button><Button variant="ghost" disabled={busy || current?.state !== 'connected'} onClick={() => { void connectionAction('connection.logout'); }}>退出连接</Button></div></section>
    <section className="content-section"><h2>连接线路</h2><FieldGroup><Field><FieldLabel htmlFor="service-route">当前线路</FieldLabel><Select value={route} onValueChange={(value) => setRoute(value as RouteId)}><SelectTrigger id="service-route" className="max-w-72"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="main">主线路</SelectItem><SelectItem value="backup">备用线路</SelectItem><SelectItem value="overseas">海外线路</SelectItem></SelectGroup></SelectContent></Select></Field><div className="flex gap-2"><Button disabled={busy} onClick={() => { void connectionAction('connection.selectRoute'); }}>应用线路</Button><Button variant="outline" disabled={busy || current?.state !== 'connected'} onClick={async () => { setBusy(true); try { setResult(await api('connection.testRoute', { route })); } finally { setBusy(false); } }}>检测线路</Button></div></FieldGroup></section>
    <section className="content-section"><h2>数据同步</h2><p className="muted-copy">打开网页或调用 MCP 时按需更新。闲置时不请求钱迹。</p><div className="flex flex-wrap gap-2"><Button disabled={busy || current?.state !== 'connected'} onClick={() => { void sync('ledger', 'incremental'); }}>同步账单</Button><Button variant="outline" disabled={busy || current?.state !== 'connected'} onClick={() => { void sync('tags', 'incremental'); }}>同步标签</Button><Button variant="outline" disabled={busy || current?.state !== 'connected'} onClick={() => { void sync('ledger', 'rebuild'); }}>全量重建账单副本</Button></div>{result ? <DataStatus reply={result} /> : null}<TaskStatus jobId={result?.jobId} /></section>
    <section className="content-section"><h2>连接 ChatGPT</h2><p className="muted-copy">MCP 地址</p><div className="mcp-address"><code>{window.location.origin}/mcp</code><Button variant="outline" size="icon" aria-label="复制 MCP 地址" onClick={async () => { await navigator.clipboard.writeText(`${window.location.origin}/mcp`); setCopied(true); }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button></div></section>
    <section className="content-section"><h2>可用功能</h2><Table><TableHeader><TableRow><TableHead>功能</TableHead><TableHead>状态</TableHead><TableHead>说明</TableHead></TableRow></TableHeader><TableBody>{capabilities.data?.map((item) => <TableRow key={item.action}><TableCell><code>{item.action}</code></TableCell><TableCell>{item.enabled ? '可用' : '未启用'}</TableCell><TableCell>{item.reason ?? (item.evidence === 'live-verified' ? '已通过真实验收' : item.evidence === 'native-vector' ? '已核对 APK 计算向量' : '已核对实现逻辑')}</TableCell></TableRow>)}</TableBody></Table></section>
  </div>;
}
