import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { Repository } from '../../src/storage/database';
import type { ActorScope } from '../../src/shared/model';

export async function createTestApp(scope: ActorScope = { uid: 'user-A', connectionEpoch: 'epoch-A' }) {
  const actor = env.QIANJI_STATE.getByName(crypto.randomUUID());
  async function repository<T>(fn: (repository: Repository, storage: DurableObjectStorage) => T): Promise<T> {
    return runInDurableObject(actor, (_instance, state) => fn(new Repository(state.storage), state.storage));
  }
  await repository((repo) => repo.bindScope(scope));
  return { actor, scope, repository, restart: () => evictDurableObject(actor) };
}
