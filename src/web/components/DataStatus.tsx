import type { AppReply } from '../../shared/reply';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
export function DataStatus({ reply, retained = false }: { reply: AppReply<unknown> | null; retained?: boolean }) {
  if (!reply) return <p className="data-status" role="status">正在读取…</p>;
  const time = reply.freshness?.syncedAt ? new Date(reply.freshness.syncedAt).toLocaleString('zh-CN', { hour12: false }) : null;
  return <div className="flex flex-col gap-3">
    <p className="data-status" role="status"><span className={reply.status === 'running' ? 'status-dot pending' : reply.freshness?.stale ? 'status-dot stale' : 'status-dot'} />
      {reply.status === 'running' ? '正在更新' : reply.freshness?.stale ? '缓存数据' : reply.freshness?.complete ? '已同步' : '服务状态'}
      {time ? ` · 上次同步：${time}` : ''}{reply.status === 'running' && retained ? ' · 当前显示已确认缓存' : ''}
    </p>
    {reply.error ? <Alert variant="destructive"><AlertTitle>暂时无法完成</AlertTitle><AlertDescription>{reply.error.message}{reply.error.code === 'CONNECTION_REQUIRED' ? <a href="/connection">前往连接钱迹</a> : null}</AlertDescription></Alert> : null}
    {reply.status === 'partial' && !reply.error ? <Alert><AlertDescription>数据尚未完整载入，当前结果可能不完整。</AlertDescription></Alert> : null}
  </div>;
}
