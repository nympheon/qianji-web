import type { ActionInput, ActionName, ActionOutputs } from '../contracts/actions';
import type { AppReply } from '../shared/reply';
import { parseAppReply } from '../shared/reply';
import type { ConnectionView, PasswordLoginInput } from '../features/connection/contract';

const pending = new Map<string, Promise<AppReply<unknown>>>();
let generation = 0;
export function clearClientCache() { generation++; pending.clear(); }
export async function api<A extends ActionName>(action: A, input: ActionInput<A>): Promise<AppReply<ActionOutputs[A]>> {
  const key = JSON.stringify([generation, action, input]);
  let request = pending.get(key);
  if (!request) {
    request = fetch('/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ action, input }) })
      .then(async (response) => { const reply = parseAppReply(await response.json()); return reply.status === 'unavailable' ? { ...reply, data: null } : reply; })
      .catch(() => ({ status: 'error' as const, data: null, freshness: null, error: { code: 'WEB_NETWORK_ERROR', message: '无法连接本服务，请检查网络后重试' } }));
    pending.set(key, request); void request.finally(() => { if (pending.get(key) === request) pending.delete(key); });
  }
  return request as Promise<AppReply<ActionOutputs[A]>>;
}
export async function login(input: PasswordLoginInput): Promise<AppReply<ConnectionView>> {
  try {
    const response = await fetch('/api/connection/login', { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify(input) });
    return parseAppReply(await response.json()) as AppReply<ConnectionView>;
  } catch { return { status: 'error', data: null, freshness: null, error: { code: 'WEB_NETWORK_ERROR', message: '无法连接本服务，请检查网络后重试' } }; }
}
