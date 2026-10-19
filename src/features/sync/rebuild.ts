import type { ActorScope, Clock, Id } from '../../shared/model';
import type { Repository } from '../../storage/database';
import type { ResourceCache } from '../../storage/cache';
import type { SyncDomain } from '../../storage/mirror';
import type { QianjiClient } from '../../protocol/client';
import type { Coordinator } from '../../actor/coordinator';
import type { ConnectionService } from '../connection/service';
import type { SyncService } from './service';
import type { JobView } from './contract';
import { DomainError } from '../../shared/errors';
import { safeProblem } from '../../operations/runner';
import { parseTagGroups } from './incremental';
import type { Problem } from '../../shared/reply';

export interface RebuildDependencies {
  repository: Repository; cache: ResourceCache; clock: Clock; client: QianjiClient;
  coordinator: Coordinator; sync: SyncService; connection: ConnectionService;
  background?: (task: Promise<unknown>) => void;
}
export class RebuildService {
  readonly #inflight = new Map<Id, Promise<void>>();
  constructor(private readonly dependencies: RebuildDependencies) {
    dependencies.coordinator.registerJobHandler('rebuild', (job) => this.resume(job.id));
    const scope = dependencies.connection.scope();
    if (scope && dependencies.connection.view().state === 'connected') {
      const rows = dependencies.repository.sql.exec<{ id: string }>("SELECT id FROM rebuild_jobs WHERE uid=? AND connection_epoch=? AND state='running'", scope.uid, scope.connectionEpoch).toArray();
      for (const row of rows) {
        if (!dependencies.repository.sql.exec('SELECT id FROM jobs WHERE id=?', row.id).toArray().length) dependencies.coordinator.jobs.put(row.id, scope, 'rebuild', { jobId: row.id });
      }
    }
  }
  private row(scope: ActorScope, id: Id): RebuildRow | null {
    this.dependencies.repository.assertScope(scope);
    return this.dependencies.repository.sql.exec<RebuildRow>('SELECT * FROM rebuild_jobs WHERE uid=? AND id=?', scope.uid, id).toArray()[0] ?? null;
  }
  async rebuild(scope: ActorScope, domains: SyncDomain[]): Promise<JobView> {
    const { repository, connection, coordinator, clock } = this.dependencies;
    repository.assertScope(scope);
    if (connection.view().state !== 'connected') throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹');
    const selected = [...new Set(domains)].sort((a,b)=>a===b?0:a==='tags'?-1:1);
    if (selected.length === 0 || selected.some((domain) => domain !== 'ledger' && domain !== 'tags')) throw new DomainError('INVALID_REBUILD_SCOPE', '当前重建范围为账单和标签');
    const id = await coordinator.jobs.persistWithWakeup(() => {
      repository.assertScope(scope);
      const existing = repository.sql.exec<{ id: string }>("SELECT id FROM rebuild_jobs WHERE uid=? AND connection_epoch=? AND state='running'", scope.uid, scope.connectionEpoch).toArray()[0];
      if (existing) return existing.id;
      const id = crypto.randomUUID();
      repository.sql.exec("INSERT INTO rebuild_jobs(id,uid,connection_epoch,domains,child_ids,state,started_ms) VALUES (?,?,?,?,?,'running',?)", id, scope.uid, scope.connectionEpoch, JSON.stringify(selected), '[]', clock.nowMs()).toArray();
      coordinator.jobs.put(id, scope, 'rebuild', { jobId: id }); return id;
    });
    const row = this.row(scope, id)!;
    if (!selected.every((domain) => (JSON.parse(row.domains) as string[]).includes(domain))) throw new DomainError('REBUILD_IN_PROGRESS', '另一范围正在重建，请等待当前任务完成');
    const pending = this.resume(id);
    if (this.dependencies.background) this.dependencies.background(pending); else await pending;
    return this.getJob(scope, id)!;
  }
  getJob(scope: ActorScope, id: Id): JobView | null {
    const row = this.row(scope, id);
    if (!row) return null;
    const domains = JSON.parse(row.domains) as ('ledger' | 'tags')[];
    const children = (JSON.parse(row.child_ids) as Id[]).map((id) => this.dependencies.sync.getJob(scope, id)!).filter(Boolean);
    return { id, domain: domains[0]!, domains, children, mode: 'rebuild', state: row.state as JobView['state'],
      phase: row.state === 'running' ? children.length === 0 ? 'waiting' : 'pulling' : row.state === 'succeeded' ? 'complete' : 'stopped',
      pages: children.reduce((count, job) => count + job.pages, 0), receivedRecords: children.reduce((count, job) => count + job.receivedRecords, 0),
      complete: row.state === 'succeeded', coverage: domains.includes('ledger') ? 'ledger' : 'tag-rows',
      error: row.error ? JSON.parse(row.error) as Problem : null };
  }
  async resume(id: Id): Promise<void> {
    const existing = this.#inflight.get(id);
    if (existing) return existing;
    const pending = this.runChunk(id); this.#inflight.set(id, pending);
    try { await pending; } finally { this.#inflight.delete(id); }
  }
  private async runChunk(id: Id): Promise<void> {
    const { repository, connection, coordinator, sync, client, cache, clock } = this.dependencies;
    const scope = connection.scope();
    if (!scope) return;
    const row = this.row(scope, id);
    if (!row || row.state !== 'running') { coordinator.jobs.remove(id); await coordinator.jobs.refreshAlarm(); return; }
    repository.assertScope({ uid: row.uid, connectionEpoch: row.connection_epoch });
    let childIds = JSON.parse(row.child_ids) as Id[];
    try {
      if (childIds.length === 0) {
        const owner = await coordinator.beginRebuild(scope, id, () => {
          if (this.row(scope, id)?.state !== 'running') throw new DomainError('REBUILD_SUPERSEDED', '重建已停止');
          const domains = JSON.parse(row.domains) as ('ledger' | 'tags')[];
          const children = domains.map((domain) => sync.createRebuildChild(scope, domain, id));
          repository.sql.exec('UPDATE rebuild_jobs SET child_ids=? WHERE id=?', JSON.stringify(children), id).toArray();
        });
        if (owner !== id) throw new DomainError('REBUILD_IN_PROGRESS', '另一重建任务持有写入边界');
        childIds = JSON.parse(this.row(scope, id)!.child_ids) as Id[];
      }
      const unfinished = childIds.find((childId) => sync.getJob(scope, childId)?.state === 'running');
      if (unfinished) await sync.resume(unfinished);
      if (this.row(scope, id)?.state !== 'running') return;
      const children = childIds.map((childId) => sync.getJob(scope, childId));
      const failed = children.find((job) => !job || job.state === 'failed' || job.state === 'truncated');
      if (failed || children.some((job) => job === null)) throw new DomainError(failed?.error?.code ?? 'REBUILD_CHILD_FAILED', failed?.error?.message ?? '重建分域任务未能完成');
      if (children.some((job) => job!.state !== 'succeeded')) {
        coordinator.jobs.put(id, scope, 'rebuild', { jobId: id }); return;
      }
      const tagChild = children.find((job) => job!.domain === 'tags');
      if (tagChild && row.catalog_done === 0) {
        const reply = await client.asReadOnly().request('tag.list', { uid: scope.uid, status: '-1', lasttime: '0' }, scope);
        const records = parseTagGroups(reply.data), checkpoint = sync.checkpoint(scope, tagChild.id)!;
        repository.transaction(() => {
          repository.assertScope({ uid: row.uid, connectionEpoch: row.connection_epoch });
          if (this.row(scope, id)?.state !== 'running') throw new DomainError('REBUILD_SUPERSEDED', '重建已停止');
          // This full grouped snapshot is the APK's explicit clear/flatten contract.
          repository.sql.exec("DELETE FROM resources WHERE uid=? AND domain='tags' AND dataset_id=? AND kind IN ('tag','tagGroup')", scope.uid, checkpoint.datasetId).toArray();
          repository.applyPage(scope, checkpoint.datasetId, { upserts: [], deletes: [], resources: records,
            pageState: repository.syncState(scope, 'tags', checkpoint.datasetId)?.pageState ?? null }, 'tags');
          repository.sql.exec('UPDATE rebuild_jobs SET catalog_done=1 WHERE id=?', id).toArray();
        });
      }
      await coordinator.endRebuild(scope, id, () => {
        for (const child of children) {
          const checkpoint = sync.checkpoint(scope, child!.id)!;
          const state = repository.syncState(scope, child!.domain, checkpoint.datasetId)!;
          repository.switchDataset(scope, child!.domain, checkpoint.datasetId, state.cursor);
        }
        if (tagChild) cache.publishSnapshot(scope, { domain: 'tags', queryKey: 'catalog:all' }, ['tag', 'tagGroup']);
        repository.sql.exec("UPDATE rebuild_jobs SET state='succeeded' WHERE id=?", id).toArray();
        coordinator.jobs.remove(id);
        repository.pruneInactiveDatasets(scope, children.map((child) => child!.domain));
      });
    } catch (error) {
      if (this.row(scope, id)?.state !== 'running') return;
      const failure = safeProblem(error);
      await coordinator.endRebuild(scope, id, () => {
        repository.sql.exec("UPDATE rebuild_jobs SET state='failed',error=? WHERE id=?", JSON.stringify(failure), id).toArray();
        for (const childId of childIds) {
          repository.sql.exec("UPDATE sync_jobs SET state='failed',error=?,finished_ms=? WHERE id=? AND state='running'", JSON.stringify(failure), clock.nowMs(), childId).toArray();
          coordinator.jobs.remove(childId);
        }
        coordinator.jobs.remove(id);
        repository.pruneInactiveDatasets(scope, (JSON.parse(row.domains) as ('ledger' | 'tags')[]));
      });
    } finally { await coordinator.jobs.refreshAlarm(); }
  }
}

type RebuildRow = { id: string; uid: string; connection_epoch: string; domains: string; child_ids: string;
  state: string; catalog_done: number; error: string | null };
