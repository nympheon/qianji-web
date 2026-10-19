import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import type { ConnectionView, RouteCheckView } from '../../features/connection/contract';
import type { AppReply } from '../../shared/reply';
import type { RouteId } from '../../protocol/profile';
import { api } from '../api';
import { DataStatus } from '../components/DataStatus';
import { TaskStatus } from '../components/TaskStatus';
import { Button } from '../components/ui/button';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

const routes: { id: RouteId; label: string }[] = [{ id: 'main', label: '主线路' }, { id: 'backup', label: '备用线路' }, { id: 'overseas', label: '海外线路' }];
type RouteResult = { testing: true } | { testing: false; reply: AppReply<RouteCheckView> };

export function ServicePage({ current, onConnection }: { current: ConnectionView | null; onConnection: (view: ConnectionView) => void }) {
  const [result, setResult] = useState<AppReply<unknown> | null>(null), [busy, setBusy] = useState(false), [route, setRoute] = useState<RouteId>(current?.route ?? 'main'), [copied, setCopied] = useState(false);
  const [routeResults, setRouteResults] = useState<Partial<Record<RouteId, RouteResult>>>({});
  async function connectionAction(action: 'connection.check' | 'connection.logout' | 'connection.selectRoute') {
    setBusy(true); try { const reply = action === 'connection.selectRoute' ? await api(action, { route }) : await api(action, {}); setResult(reply); if (reply.data) onConnection(reply.data); } finally { setBusy(false); }
  }
  async function sync(domain: 'ledger' | 'tags', mode: 'incremental' | 'rebuild') { setBusy(true); try { setResult(await api('sync.start', { domain, mode })); } finally { setBusy(false); } }
  async function testRoutes() {
    if (busy || current?.state !== 'connected') return;
    setBusy(true); setRouteResults({ main: { testing: true }, backup: { testing: true }, overseas: { testing: true } });
    try {
      await Promise.all(routes.map(async ({ id }) => {
        const reply = await api('connection.testRoute', { route: id });
        setRouteResults((previous) => ({ ...previous, [id]: { testing: false, reply } }));
      }));
    } finally { setBusy(false); }
  }
  return <div className="page-stack"><section className="content-section"><h2>钱迹连接</h2><dl className="service-details"><dt>状态</dt><dd>{current?.state === 'connected' ? '已连接' : current?.state === 'needs_login' ? '需要重新登录' : '未连接'}</dd><dt>账号</dt><dd>{current?.user?.name || '—'}</dd><dt>最近检查</dt><dd>{current?.lastCheckedAt ? new Date(current.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查'}</dd></dl><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { void connectionAction('connection.check'); }}>检查登录状态</Button><Button variant="outline" asChild><a href="/connection">重新登录</a></Button><Button variant="ghost" disabled={busy || current?.state !== 'connected'} onClick={() => { void connectionAction('connection.logout'); }}>退出连接</Button></div></section>
    <section className="content-section"><h2>连接线路</h2><FieldGroup><Field><FieldLabel htmlFor="service-route">当前线路</FieldLabel><Select value={route} disabled={busy} onValueChange={(value) => setRoute(value as RouteId)}><SelectTrigger id="service-route" className="max-w-72"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{routes.map(({ id, label }) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { void connectionAction('connection.selectRoute'); }}>应用线路</Button><Button variant="outline" disabled={busy || current?.state !== 'connected'} onClick={() => { void testRoutes(); }}>检测三条线路</Button></div></FieldGroup>
      <p className="muted-copy mt-4">{current?.state === 'connected' ? '手动检测服务器到钱迹接口的耗时，不会自动切换线路。' : '登录钱迹后可检测三条线路。'}</p>
      <Table aria-label="线路延迟检测" aria-live="polite"><TableHeader><TableRow><TableHead>线路</TableHead><TableHead>延迟</TableHead><TableHead>检测结果</TableHead></TableRow></TableHeader><TableBody>{routes.map(({ id, label }) => {
        const check = routeResults[id], reply = check && !check.testing ? check.reply : null, data = reply?.data, ok = reply?.status === 'ready' && data?.status === 'ok';
        return <TableRow key={id}><TableCell>{label}</TableCell><TableCell>{ok && data.latencyMs !== null ? `${data.latencyMs} ms` : '—'}</TableCell><TableCell className="whitespace-normal break-words">{!check ? '未检测' : check.testing ? '检测中…' : ok ? '连接正常' : data?.error?.message ?? reply?.error?.message ?? '检测未完成，请重试'}</TableCell></TableRow>;
      })}</TableBody></Table>
    </section>
    <section className="content-section"><h2>数据同步</h2><p className="muted-copy">打开网页或调用 MCP 时按需更新。闲置时不请求钱迹。</p><div className="flex flex-wrap gap-2"><Button disabled={busy || current?.state !== 'connected'} onClick={() => { void sync('ledger', 'incremental'); }}>同步账单</Button><Button variant="outline" disabled={busy || current?.state !== 'connected'} onClick={() => { void sync('tags', 'incremental'); }}>同步标签</Button><Button variant="outline" disabled={busy || current?.state !== 'connected'} onClick={() => { void sync('ledger', 'rebuild'); }}>全量重建账单副本</Button></div>{result ? <DataStatus reply={result} /> : null}<TaskStatus jobId={result?.jobId} /></section>
    <section className="content-section"><h2>连接 ChatGPT</h2><p className="muted-copy">MCP 地址</p><div className="mcp-address"><code>{window.location.origin}/mcp</code><Button variant="outline" size="icon" aria-label="复制 MCP 地址" onClick={async () => { await navigator.clipboard.writeText(`${window.location.origin}/mcp`); setCopied(true); }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button></div></section>
  </div>;
}
