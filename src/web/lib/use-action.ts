import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionInput, ActionName, ActionOutputs } from '../../contracts/actions';
import type { AppReply } from '../../shared/reply';
import { api } from '../api';

export function useAction<A extends ActionName>(action: A, input: ActionInput<A>) {
  const key = JSON.stringify([action, input]), [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; reply: AppReply<ActionOutputs[A]> | null; lastData: ActionOutputs[A] | null; loading: boolean }>({ key, reply: null, lastData: null, loading: true });
  const inputRef = useRef(input); inputRef.current = input;
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, polls = 0;
    const update = (reply: AppReply<ActionOutputs[A]>) => {
      if (disposed) return;
      setState((old) => ({ key, reply, lastData: reply.data ?? (old.key === key ? old.lastData : null), loading: false }));
      if (reply.status === 'running' && reply.jobId) schedule(reply.jobId);
    };
    const load = async () => { if (disposed || document.hidden) return; update(await api(action, inputRef.current)); };
    const poll = async (jobId: string) => {
      if (disposed || document.hidden || ++polls > 60) return;
      const progress = await api('sync.status', { jobId }); if (disposed) return;
      if (progress.status === 'running') schedule(jobId);
      else if (progress.status === 'ready') await load();
      else setState((old) => ({ ...old, loading: false, reply: { status: 'partial', data: null, freshness: old.reply?.freshness ? { ...old.reply.freshness, stale: true, complete: false } : null, ...(progress.error ? { error: progress.error } : {}) } }));
    };
    const schedule = (jobId: string) => { if (!disposed && !document.hidden) timer = setTimeout(() => { void poll(jobId); }, 2000); };
    const visible = () => { if (timer) clearTimeout(timer); if (!document.hidden) { polls = 0; void load(); } };
    setState((old) => ({ key, reply: old.key === key ? old.reply : null, lastData: old.key === key ? old.lastData : null, loading: true }));
    void load(); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [key, action, refresh]);
  const refetch = useCallback(() => setRefresh((old) => old + 1), []);
  return { reply: state.key === key ? state.reply : null, data: state.key === key ? state.lastData : null, loading: state.key !== key || state.loading, refetch };
}
