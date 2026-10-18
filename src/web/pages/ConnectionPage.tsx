import { useState, type FormEvent } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { api, login } from '../api';
import type { ConnectionView } from '../../features/connection/contract';
import type { RouteId } from '../../protocol/profile';
import type { AppReply } from '../../shared/reply';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { Alert, AlertDescription } from '../components/ui/alert';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../components/ui/input-group';

export function ConnectionPage({ current, onConnected }: { current: ConnectionView | null; onConnected: (view: ConnectionView) => void }) {
  const [account, setAccount] = useState(''), [password, setPassword] = useState(''), [show, setShow] = useState(false), [route, setRoute] = useState<RouteId>(current?.route ?? 'main');
  const [busy, setBusy] = useState(false), [result, setResult] = useState<AppReply<unknown> | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setResult(null);
    try {
      const selected = await api('connection.selectRoute', { route }); if (selected.status !== 'ready') { setResult(selected); return; }
      const reply = await login({ account, password }); setResult(reply); if (reply.status === 'ready' && reply.data) onConnected(reply.data);
    } finally { setPassword(''); setBusy(false); }
  }
  return <div className="connection-wrap"><section className="connection-panel"><h1>连接钱迹</h1><p className="page-description">使用手机号或邮箱和密码连接你的钱迹账号。</p>
    <form onSubmit={(event) => { void submit(event); }}><FieldGroup>
      <Field><FieldLabel htmlFor="account">手机号或邮箱</FieldLabel><Input id="account" autoComplete="username" value={account} onChange={(event) => setAccount(event.target.value)} required disabled={busy} /></Field>
      <Field><FieldLabel htmlFor="password">密码</FieldLabel><InputGroup><InputGroupInput id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /><InputGroupAddon align="inline-end"><InputGroupButton type="button" variant="ghost" size="icon-xs" aria-label={show ? '隐藏密码' : '显示密码'} onClick={() => setShow(!show)}>{show ? <EyeOffIcon /> : <EyeIcon />}</InputGroupButton></InputGroupAddon></InputGroup></Field>
      <Field><FieldLabel>线路选择</FieldLabel><ToggleGroup type="single" value={route} onValueChange={(value) => { if (['main', 'backup', 'overseas'].includes(value)) setRoute(value as RouteId); }} aria-label="线路选择" disabled={busy}><ToggleGroupItem value="main">主线路</ToggleGroupItem><ToggleGroupItem value="backup">备用线路</ToggleGroupItem><ToggleGroupItem value="overseas">海外线路</ToggleGroupItem></ToggleGroup></Field>
      <Button type="submit" size="lg" disabled={busy}>{busy ? '正在连接…' : '连接钱迹'}</Button>
      {result?.error ? <Alert variant="destructive"><AlertDescription>{result.error.message}</AlertDescription></Alert> : null}
      <FieldDescription className="text-center">密码仅用于本次登录，不会保存。</FieldDescription>
    </FieldGroup></form>
  </section></div>;
}
