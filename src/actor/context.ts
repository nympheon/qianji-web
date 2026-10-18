import type { Clock } from '../shared/model';
import { Repository } from '../storage/database';
import { QianjiClient } from '../protocol/client';
import { Coordinator } from './coordinator';

export function createActorContext(storage: DurableObjectStorage) {
  const repository = new Repository(storage);
  const clock: Clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
  const client = new QianjiClient({
    clock,
    deviceId: () => repository.sql.exec<{ device_id: string }>('SELECT device_id FROM connection WHERE singleton=1').one().device_id,
    route: () => 'main',
    // Credentials and real session resolution are connected in the next task.
    session: async () => null,
  });
  const coordinator = new Coordinator({ repository, client, clock }, new Map());
  return { repository, clock, client, coordinator };
}
