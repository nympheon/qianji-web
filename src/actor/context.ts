import type { Clock } from '../shared/model';
import { Repository } from '../storage/database';
import { QianjiClient } from '../protocol/client';
import { Coordinator } from './coordinator';
import { CredentialVault } from '../features/connection/vault';
import { ConnectionService } from '../features/connection/service';
import type { RouteId } from '../protocol/profile';

export function createActorContext(storage: DurableObjectStorage, secrets: { QIANJI_CREDENTIAL_KEY?: string } = {}) {
  const repository = new Repository(storage);
  const clock: Clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
  const client = new QianjiClient({
    clock,
    deviceId: () => repository.sql.exec<{ device_id: string }>('SELECT device_id FROM connection WHERE singleton=1').one().device_id,
    route: () => repository.sql.exec<{ route: string }>('SELECT route FROM connection WHERE singleton=1').one().route as RouteId,
    session: (scope) => connection.session(scope),
    onSessionExpired: (scope, generation) => connection.expire(scope, generation),
  });
  const coordinator = new Coordinator({ repository, client, clock }, new Map());
  const instanceId = repository.sql.exec<{ value: string }>("SELECT value FROM instance_meta WHERE key='instance_id'").one().value;
  const vault = new CredentialVault(secrets.QIANJI_CREDENTIAL_KEY, instanceId);
  const connection = new ConnectionService({ repository, client, coordinator, clock, vault });
  return { repository, clock, client, coordinator, connection };
}
