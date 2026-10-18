import type { Clock } from '../shared/model';
import { Repository } from '../storage/database';
import { QianjiClient } from '../protocol/client';
import { Coordinator } from './coordinator';
import { CredentialVault } from '../features/connection/vault';
import { ConnectionService } from '../features/connection/service';
import type { RouteId } from '../protocol/profile';
import { SyncService } from '../features/sync/service';
import { RebuildService } from '../features/sync/rebuild';
import { FreshnessService } from '../features/sync/freshness';
import { ResourceCache } from '../storage/cache';
import { LedgerService } from '../features/ledger/service';
import { createLedgerMutationHandler } from '../features/ledger/write';
import { LedgerWriteService } from '../features/ledger/write-service';

export function createActorContext(storage: DurableObjectStorage, secrets: { QIANJI_CREDENTIAL_KEY?: string } = {}, execution?: { waitUntil(task: Promise<unknown>): void }) {
  const repository = new Repository(storage);
  const clock: Clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
  const client = new QianjiClient({
    clock,
    deviceId: () => repository.sql.exec<{ device_id: string }>('SELECT device_id FROM connection WHERE singleton=1').one().device_id,
    route: () => repository.sql.exec<{ route: string }>('SELECT route FROM connection WHERE singleton=1').one().route as RouteId,
    session: (scope) => connection.session(scope),
    onSessionExpired: (scope, generation) => connection.expire(scope, generation),
  });
  const executionOptions = execution ? { background: (task: Promise<unknown>) => execution.waitUntil(task) } : undefined;
  const background = executionOptions ?? {};
  const billHandler = createLedgerMutationHandler({ reconcileSource: async () => {
    const current = connection.scope(); if (!current) return false;
    const result = await freshness.ensureFresh(current, ['ledger'], 'manual-incremental');
    return result.job?.state === 'succeeded';
  } });
  const coordinator = new Coordinator({ repository, client, clock }, new Map(['ledger.create', 'ledger.edit', 'ledger.delete'].map((action) => [action, billHandler])), executionOptions);
  const instanceId = repository.sql.exec<{ value: string }>("SELECT value FROM instance_meta WHERE key='instance_id'").one().value;
  const vault = new CredentialVault(secrets.QIANJI_CREDENTIAL_KEY, instanceId);
  const connection = new ConnectionService({ repository, client, coordinator, clock, vault });
  const cache = new ResourceCache(repository, clock);
  const sync = new SyncService({ repository, client, coordinator, clock, connection, rebuild: (scope, domains) => rebuild.rebuild(scope, domains), ...background });
  const rebuild = new RebuildService({ repository, cache, client, coordinator, clock, connection, sync, ...background });
  const freshness = new FreshnessService({ repository, clock, sync });
  const ledgerWrites = new LedgerWriteService({ repository, coordinator, connection });
  const ledger = new LedgerService({ repository, connection, freshness, clock, writes: ledgerWrites });
  return { repository, clock, client, coordinator, connection, sync, cache, rebuild, freshness, ledger, ledgerWrites };
}
