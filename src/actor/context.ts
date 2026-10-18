import type { Clock } from '../shared/model';
import { Repository } from '../storage/database';

export function createActorContext(storage: DurableObjectStorage) {
  const repository = new Repository(storage);
  const clock: Clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
  return { repository, clock };
}
