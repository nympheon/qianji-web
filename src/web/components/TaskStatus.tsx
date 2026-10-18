import { useState } from 'react';
import { api } from '../api';
import { Button } from './ui/button';
import type { JobView } from '../../features/sync/contract';
export function TaskStatus({ jobId, onFinished }: { jobId: string | undefined; onFinished?: () => void }) {
  const [job, setJob] = useState<JobView | null>(null), [busy, setBusy] = useState(false);
  if (!jobId) return null;
  return <div className="task-status"><span>{job ? `已读取 ${job.pages} 页 · ${job.receivedRecords} 条记录${job.state === 'succeeded' ? ' · 已完成' : ''}` : '同步任务已保存，可查看进度'}</span><Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const reply = await api('sync.status', { jobId }); setJob(reply.data); if (reply.data?.state === 'succeeded') onFinished?.(); } finally { setBusy(false); } }}>查看进度</Button></div>;
}
