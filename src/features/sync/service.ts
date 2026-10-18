import type { ActorScope, Clock, Id } from '../../shared/model';
import type { Repository } from '../../storage/database';
import type { QianjiClient } from '../../protocol/client';
import type { Coordinator } from '../../actor/coordinator';
import type { ConnectionService } from '../connection/service';
import type { SyncInput, JobView } from './contract';
import { syncInputSchema, type SyncCheckpoint } from './contract';
import { DomainError } from '../../shared/errors';
import { stringifyWire, type WireJson } from '../../shared/wire-json';
import { invalidSync, integerText, parseCheckpoint, parseLedgerPage, parseTagPage, wireObject } from './incremental';
import type { WireObject } from '../../protocol/signer';
import type { MirrorPage } from '../../storage/mirror';
import { safeProblem } from '../../operations/runner';

export interface SyncDependencies {
  repository: Repository; client: QianjiClient; coordinator: Coordinator;
  connection: ConnectionService; clock: Clock; delay?: (milliseconds: number) => Promise<void>;
  rebuild?: (scope: ActorScope, domains: SyncInput['domain'][]) => Promise<JobView>;
}
type SyncRow = { id: string; uid: string; connection_epoch: string; domain: string; mode: string;
  state: string; pages: number; changed_records: number; checkpoint: string; error: string | null };
function view(row: SyncRow): JobView {
  return { id: row.id, domain: row.domain as SyncInput['domain'], mode: row.mode as SyncInput['mode'], state: row.state as JobView['state'],
    phase: row.state === 'running' ? 'pulling' : row.state === 'succeeded' ? 'complete' : 'stopped', pages: row.pages,
    receivedRecords: row.changed_records, complete: row.state === 'succeeded', error: row.error ? JSON.parse(row.error) as JobView['error'] : null,
    coverage: row.domain === 'tags' ? 'tag-rows' : 'ledger' };
}
export class SyncService {
  readonly #inflight = new Map<Id, Promise<void>>();
  constructor(private readonly dependencies: SyncDependencies) {
    dependencies.coordinator.registerJobHandler('sync', (job) => this.resume(job.id));
    const scope = dependencies.connection.scope();
    if (scope && dependencies.connection.view().state === 'connected') {
      const rows = dependencies.repository.sql.exec<{ id: string; checkpoint: string }>("SELECT id,checkpoint FROM sync_jobs WHERE uid=? AND connection_epoch=? AND state='running'", scope.uid, scope.connectionEpoch).toArray();
      for (const row of rows) {
        let owner: Id | undefined;
        try { owner = parseCheckpoint(row.checkpoint).ownerJobId; } catch { /* The resumed job records a stable checkpoint error. */ }
        const id = owner ?? row.id;
        if (dependencies.repository.sql.exec('SELECT id FROM jobs WHERE id=?', id).toArray().length === 0) dependencies.coordinator.jobs.put(id, scope, owner ? 'rebuild' : 'sync', { jobId: id });
      }
    }
  }
  private row(scope: ActorScope, id: Id): SyncRow | null {
    this.dependencies.repository.assertScope(scope);
    return this.dependencies.repository.sql.exec<SyncRow>('SELECT * FROM sync_jobs WHERE uid=? AND id=?', scope.uid, id).toArray()[0] ?? null;
  }
  async start(input: SyncInput): Promise<JobView> {
    const parsed = syncInputSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_SYNC_INPUT', '同步参数无效');
    const { repository, connection, coordinator, clock } = this.dependencies;
    const scope = connection.scope();
    if (!scope || connection.view().state !== 'connected') throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹');
    if (input.mode === 'incremental' && this.dependencies.rebuild) {
      const running = repository.sql.exec<{ domains: string }>('SELECT r.domains FROM sync_barrier b JOIN rebuild_jobs r ON r.id=b.job_id WHERE b.uid=? AND b.connection_epoch=? AND r.state=\'running\'', scope.uid, scope.connectionEpoch).toArray()[0];
      if (running && (JSON.parse(running.domains) as string[]).includes(input.domain)) return this.dependencies.rebuild(scope, [input.domain]);
    }
    if (input.mode === 'rebuild') {
      if (!this.dependencies.rebuild) throw new DomainError('REBUILD_UNAVAILABLE', '全量重建尚未接入');
      return this.dependencies.rebuild(scope, [input.domain]);
    }
    const id = await coordinator.jobs.persistWithWakeup(() => {
      repository.assertScope(scope);
      const running = repository.sql.exec<{ id: string }>("SELECT id FROM sync_jobs WHERE uid=? AND connection_epoch=? AND domain=? AND state='running'", scope.uid, scope.connectionEpoch, input.domain).toArray()[0];
      if (running) return running.id;
      const active = repository.dataset(scope, input.domain);
      const cursor = active ? repository.syncState(scope, input.domain, active.id)?.cursor ?? null : null;
      const datasetId = active && cursor !== null ? active.id : crypto.randomUUID();
      repository.createDataset(scope, input.domain, datasetId);
      let full = cursor === null;
      if (input.domain === 'ledger' && cursor !== null) {
        const root = wireObject(cursor)['-1'];
        full = root == null || BigInt(integerText(root)) <= 0n;
      }
      const checkpoint: SyncCheckpoint = { scope, datasetId, startCursor: cursor, collectedTimes: {}, bookId: '-1', pageOffset: '0', pageSign: '', tagPage: 0, full };
      const id = crypto.randomUUID();
      repository.sql.exec("INSERT INTO sync_jobs(id,uid,connection_epoch,domain,mode,state,checkpoint,started_ms) VALUES (?,?,?,?,?,'running',?,?)", id, scope.uid, scope.connectionEpoch, input.domain, input.mode,
        stringifyWire({ ...checkpoint, scope: { ...scope } }), clock.nowMs()).toArray();
      repository.applyPage(scope, datasetId, { upserts: [], deletes: [], resources: [], pageState: null, complete: false }, input.domain);
      coordinator.jobs.put(id, scope, 'sync', { jobId: id });
      return id;
    });
    await this.resume(id);
    return this.getJob(scope, id)!;
  }
  getJob(scope: ActorScope, id: Id): JobView | null { const row = this.row(scope, id); return row ? view(row) : null; }
  checkpoint(scope: ActorScope, id: Id): SyncCheckpoint | null {
    const row = this.row(scope, id); return row ? parseCheckpoint(row.checkpoint) : null;
  }
  /** Called only while the owning durable rebuild barrier is held. No network I/O. */
  createRebuildChild(scope: ActorScope, domain: SyncInput['domain'], ownerJobId: Id): Id {
    const { repository, clock, coordinator } = this.dependencies;
    repository.assertScope(scope);
    if (!repository.sql.exec('SELECT job_id FROM sync_barrier WHERE uid=? AND connection_epoch=? AND job_id=?', scope.uid, scope.connectionEpoch, ownerJobId).toArray().length) throw new DomainError('REBUILD_BARRIER_REQUIRED', '重建需要持久写入边界');
    const old = repository.sql.exec<{ id: string }>("SELECT id FROM sync_jobs WHERE uid=? AND domain=? AND state='running'", scope.uid, domain).toArray();
    for (const row of old) coordinator.jobs.remove(row.id);
    repository.sql.exec("UPDATE sync_jobs SET state='failed',error=?,finished_ms=? WHERE uid=? AND domain=? AND state='running'", JSON.stringify({ code: 'SYNC_SUPERSEDED', message: '本轮同步已由全量重建接管' }), clock.nowMs(), scope.uid, domain).toArray();
    const id = crypto.randomUUID(), datasetId = crypto.randomUUID();
    repository.createDataset(scope, domain, datasetId);
    const checkpoint: SyncCheckpoint = { scope, datasetId, startCursor: null, collectedTimes: {}, bookId: '-1', pageOffset: '0', pageSign: '', tagPage: 0, full: true, ownerJobId };
    repository.sql.exec("INSERT INTO sync_jobs(id,uid,connection_epoch,domain,mode,state,checkpoint,started_ms) VALUES (?,?,?,?,'rebuild','running',?,?)", id, scope.uid, scope.connectionEpoch, domain, stringifyWire({ ...checkpoint, scope: { ...scope } }), clock.nowMs()).toArray();
    return id;
  }
  async resume(id: Id): Promise<void> {
    const existing = this.#inflight.get(id);
    if (existing) return existing;
    const pending = this.runChunk(id);
    this.#inflight.set(id, pending);
    try { await pending; } finally { this.#inflight.delete(id); }
  }
  private async runChunk(id: Id): Promise<void> {
    const { repository, connection, client, coordinator, clock } = this.dependencies;
    const scope = connection.scope();
    if (!scope) return;
    let row = this.row(scope, id);
    if (!row || row.state !== 'running') { coordinator.jobs.remove(id); await coordinator.jobs.refreshAlarm(); return; }
    try {
      const checkpoint = parseCheckpoint(row.checkpoint);
      repository.assertScope(checkpoint.scope);
      // Bounded invocation. The persisted checkpoint continues through the shared alarm.
      for (let chunk = 0; chunk < 2; chunk++) {
        if (row.pages >= (row.domain === 'ledger' ? 200 : 40)) {
          repository.sql.exec("UPDATE sync_jobs SET state='truncated',error=?,finished_ms=? WHERE id=?", JSON.stringify({ code: 'SYNC_PAGE_LIMIT', message: '同步达到客户端分页保护上限，未标记为完整' }), clock.nowMs(), id).toArray();
          coordinator.jobs.remove(id); break;
        }
        if (checkpoint.full && row.domain === 'ledger' && row.pages > 0) {
          const milliseconds = 150 + crypto.getRandomValues(new Uint8Array(1))[0]! % 71;
          await (this.dependencies.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(milliseconds);
        }
        const params: WireObject = row.domain === 'ledger' ? {
          uid: scope.uid, bookid: checkpoint.bookId, pageoffset: checkpoint.pageOffset, pagesign: checkpoint.pageSign,
          ...(checkpoint.startCursor === null ? {} : { lasttimes: stringifyWire(checkpoint.startCursor) }),
        } : { uid: scope.uid, lasttime: checkpoint.startCursor === null ? '0' : integerText(checkpoint.startCursor), page: String(checkpoint.tagPage) };
        const sourceGeneration = repository.sourceGeneration(scope, row.domain as SyncInput['domain']);
        const sourceDatasetId = repository.dataset(scope, row.domain as SyncInput['domain'])?.id ?? null;
        const reply = await client.request(row.domain === 'ledger' ? 'syncv2.pull' : 'tag.pull', params, checkpoint.scope);
        repository.assertScope(checkpoint.scope);
        if (this.row(scope, id)?.state !== 'running') return;
        if (!checkpoint.ownerJobId && (sourceGeneration !== repository.sourceGeneration(scope, row.domain as SyncInput['domain']) || sourceDatasetId !== (repository.dataset(scope, row.domain as SyncInput['domain'])?.id ?? null))) {
          throw new DomainError('SYNC_SUPERSEDED', '源数据已更新，本页旧响应未应用，请按需重新校验');
        }
        let hasMore: boolean, received: number;
        let page: MirrorPage;
        let cursor: WireJson;
        if (row.domain === 'ledger') {
          const result = parseLedgerPage(reply.data);
          if (result.hasMore && result.next.bookId === checkpoint.bookId && result.next.pageOffset === checkpoint.pageOffset && result.next.pageSign === checkpoint.pageSign) return invalidSync();
          checkpoint.collectedTimes = { ...wireObject(checkpoint.collectedTimes), ...result.lastTimes };
          checkpoint.bookId = result.next.bookId; checkpoint.pageOffset = result.next.pageOffset; checkpoint.pageSign = result.next.pageSign;
          hasMore = result.hasMore; received = result.bills.length + result.deletes.length + result.resources.length;
          page = { upserts: result.bills, deletes: result.deletes, resources: result.resources, pageState: { ...result.next } };
          cursor = checkpoint.collectedTimes;
        } else {
          const result = parseTagPage(reply.data);
          checkpoint.tagPage++;
          hasMore = result.hasMore; received = result.resources.length + result.deletes.length;
          page = { upserts: [], deletes: [], resources: result.resources, resourceDeletes: result.deletes, pageState: { page: checkpoint.tagPage } };
          cursor = String(clock.nowMs());
        }
        const complete = !hasMore;
        repository.transaction(() => {
          repository.assertScope(checkpoint.scope);
          repository.applyPage(scope, checkpoint.datasetId, { ...page, complete, ...(complete ? { cursor, validatedAt: clock.nowIso() } : {}) }, row!.domain as SyncInput['domain']);
          if (complete && !checkpoint.ownerJobId) repository.switchDataset(scope, row!.domain as SyncInput['domain'], checkpoint.datasetId, cursor);
          repository.sql.exec('UPDATE sync_jobs SET state=?,pages=pages+1,changed_records=changed_records+?,checkpoint=?,finished_ms=? WHERE id=?', complete ? 'succeeded' : 'running', received,
            stringifyWire({ ...checkpoint, scope: { ...checkpoint.scope } }), complete ? clock.nowMs() : null, id).toArray();
          if (complete) coordinator.jobs.remove(id);
          else coordinator.jobs.put(checkpoint.ownerJobId ?? id, scope, checkpoint.ownerJobId ? 'rebuild' : 'sync', { jobId: checkpoint.ownerJobId ?? id });
        });
        row = this.row(scope, id)!;
        if (complete) break;
      }
    } catch (error) {
      const detail = safeProblem(error);
      repository.sql.exec("UPDATE sync_jobs SET state='failed',error=?,finished_ms=? WHERE id=? AND state='running'", JSON.stringify(detail), clock.nowMs(), id).toArray();
      coordinator.jobs.remove(id);
    } finally {
      const current = connection.scope();
      if (current?.uid === scope.uid && current.connectionEpoch === scope.connectionEpoch) repository.pruneInactiveDatasets(scope, [row.domain as SyncInput['domain']]);
      await coordinator.jobs.refreshAlarm();
    }
  }
}
