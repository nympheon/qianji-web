import type { ActorScope, Clock, Id } from '../shared/model';
import type { SyncDomain } from './mirror';
import type { ResourceKind, ResourceRecord } from './resources';
import type { Repository } from './database';
import { DomainError } from '../shared/errors';
import { parseWire } from '../shared/wire-json';

type QueryRow = { dataset_id: string; resource_kind: string | null; validated_ms: number | null; changed_ms: number | null;
  complete: number; invalidated: number; membership_revision: number };
type MemberRow = { kind: string; resource_id: string; position: number };

export interface CacheKey { domain: SyncDomain; queryKey: string; resourceKind?: ResourceKind }
export interface CacheReadStamp { scope: ActorScope; key: CacheKey; datasetId: Id | null; generation: number }
export interface ResourceRefresh { items: ResourceRecord[]; complete: boolean; deletes?: Id[] }
export interface CacheView {
  items: ResourceRecord[]; complete: boolean; stale: boolean; validatedAt: number | null;
  needsValidation:boolean;
  changedAt: number | null; revision: string;
}
export class ResourceCache {
  constructor(private readonly repository: Repository, private readonly clock: Clock) {}
  private query(scope: ActorScope, key: CacheKey): QueryRow | null {
    return this.repository.sql.exec<QueryRow>('SELECT * FROM source_queries WHERE uid=? AND domain=? AND query_key=?', scope.uid, key.domain, key.queryKey).toArray()[0] ?? null;
  }
  captureRead(scope: ActorScope, key: CacheKey): CacheReadStamp {
    this.repository.assertScope(scope);
    return { scope: { ...scope }, key: { ...key }, datasetId: this.repository.dataset(scope, key.domain)?.id ?? null, generation: this.repository.sourceGeneration(scope, key.domain) };
  }
  private dataset(scope: ActorScope, domain: SyncDomain): Id {
    const active = this.repository.dataset(scope, domain);
    if (active) return active.id;
    const id = crypto.randomUUID();
    this.repository.createDataset(scope, domain, id);
    // Resource source completeness belongs to its query, not the whole online domain.
    this.repository.sql.exec('INSERT INTO active_datasets(uid,domain,dataset_id) VALUES (?,?,?)', scope.uid, domain, id).toArray();
    return id;
  }
  applyRead(stamp: CacheReadStamp, result: ResourceRefresh): 'applied' | 'superseded' {
    try { this.repository.assertScope(stamp.scope); } catch { return 'superseded'; }
    const { scope, key } = stamp;
    if ((this.repository.dataset(scope, key.domain)?.id ?? null) !== stamp.datasetId || this.repository.sourceGeneration(scope, key.domain) !== stamp.generation) return 'superseded';
    if (result.deletes?.length && !key.resourceKind) throw new DomainError('RESOURCE_DELETE_KIND_REQUIRED', '明确资源类型后才能应用删除回执');
    if (key.resourceKind && result.items.some((item) => item.kind !== key.resourceKind)) throw new DomainError('RESOURCE_KIND_MISMATCH', '资源响应类型不匹配');
    this.repository.transaction(() => {
      const datasetId = this.dataset(scope, key.domain), before = this.repository.dataset(scope, key.domain)!;
      const query = this.query(scope, key);
      const previous = this.repository.sql.exec<MemberRow>('SELECT kind,resource_id,position FROM source_members WHERE uid=? AND domain=? AND query_key=? ORDER BY position', scope.uid, key.domain, key.queryKey).toArray();
      const members = [...new Map(result.items.map((item) => [JSON.stringify([item.kind, item.id]), item])).values()];
      this.repository.applyPage(scope, datasetId, { upserts: [], deletes: [], resources: members,
        resourceDeletes: (result.deletes ?? []).map((id) => ({ id, kind: key.resourceKind! })),
        pageState: this.repository.syncState(scope, key.domain, datasetId)?.pageState ?? null }, key.domain);
      const membershipChanged = query?.dataset_id !== datasetId || JSON.stringify(previous.map((item) => [item.kind, item.resource_id])) !== JSON.stringify(members.map((item) => [item.kind, item.id]));
      const entityChanged = this.repository.dataset(scope, key.domain)!.revision !== before.revision;
      const now = this.clock.nowMs();
      this.repository.sql.exec('INSERT INTO source_queries(uid,domain,query_key,dataset_id,resource_kind,validated_ms,changed_ms,complete,invalidated,membership_revision) VALUES (?,?,?,?,?,?,?,?,0,?) ON CONFLICT(uid,domain,query_key) DO UPDATE SET dataset_id=excluded.dataset_id,resource_kind=excluded.resource_kind,validated_ms=excluded.validated_ms,changed_ms=excluded.changed_ms,complete=excluded.complete,invalidated=0,membership_revision=excluded.membership_revision',
        scope.uid, key.domain, key.queryKey, datasetId, key.resourceKind ?? null, result.complete ? now : query?.validated_ms ?? null,
        entityChanged || membershipChanged ? now : query?.changed_ms ?? null, Number(result.complete), (query?.membership_revision ?? 0) + Number(membershipChanged)).toArray();
      this.repository.sql.exec('DELETE FROM source_members WHERE uid=? AND domain=? AND query_key=?', scope.uid, key.domain, key.queryKey).toArray();
      for (let position = 0; position < members.length; position++) {
        const item = members[position]!;
        this.repository.sql.exec('INSERT INTO source_members(uid,domain,query_key,kind,resource_id,position) VALUES (?,?,?,?,?,?)', scope.uid, key.domain, key.queryKey, item.kind, item.id, position).toArray();
      }
    });
    return 'applied';
  }
  invalidateSource(scope: ActorScope, key: CacheKey): void {
    this.repository.transaction(() => {
      this.repository.bumpSourceGeneration(scope, key.domain);
      this.repository.sql.exec('UPDATE source_queries SET invalidated=1 WHERE uid=? AND domain=? AND query_key=?', scope.uid, key.domain, key.queryKey).toArray();
    });
  }
  confirmResources(scope: ActorScope, domain: SyncDomain, items: ResourceRecord[]): void {
    this.repository.assertScope(scope);
    this.repository.transaction(() => {
      this.repository.bumpSourceGeneration(scope, domain);
      const id = this.dataset(scope, domain);
      this.repository.applyPage(scope, id, { upserts: [], deletes: [], resources: items,
        pageState: this.repository.syncState(scope, domain, id)?.pageState ?? null }, domain);
    });
  }
  /** Caller has verified a complete official snapshot already persisted in the active dataset. */
  publishSnapshot(scope: ActorScope, key: CacheKey, kinds: readonly ResourceKind[]): void {
    this.repository.assertScope(scope);
    if (kinds.length === 0) throw new DomainError('RESOURCE_KIND_REQUIRED', '完整集合需要明确资源类型');
    this.repository.transaction(() => {
      const dataset = this.repository.dataset(scope, key.domain);
      if (!dataset) throw new DomainError('DATASET_MISSING', '完整集合尚未保存');
      const now = this.clock.nowMs(), old = this.query(scope, key);
      this.repository.sql.exec('INSERT INTO source_queries(uid,domain,query_key,dataset_id,resource_kind,validated_ms,changed_ms,complete,invalidated,membership_revision) VALUES (?,?,?,?,?,?,?,1,0,?) ON CONFLICT(uid,domain,query_key) DO UPDATE SET dataset_id=excluded.dataset_id,resource_kind=excluded.resource_kind,validated_ms=excluded.validated_ms,changed_ms=excluded.changed_ms,complete=1,invalidated=0,membership_revision=excluded.membership_revision', scope.uid, key.domain, key.queryKey, dataset.id, key.resourceKind ?? null, now, now, (old?.membership_revision ?? 0) + 1).toArray();
      this.repository.sql.exec('DELETE FROM source_members WHERE uid=? AND domain=? AND query_key=?', scope.uid, key.domain, key.queryKey).toArray();
      this.repository.sql.exec(`INSERT INTO source_members(uid,domain,query_key,kind,resource_id,position) SELECT uid,domain,?,kind,id,ROW_NUMBER() OVER(ORDER BY kind,id)-1 FROM resources WHERE uid=? AND domain=? AND dataset_id=? AND kind IN (${kinds.map(() => '?').join(',')})`, key.queryKey, scope.uid, key.domain, dataset.id, ...kinds).toArray();
    });
  }
  read(scope: ActorScope, key: CacheKey): CacheView {
    this.repository.assertScope(scope);
    const query = this.query(scope, key), dataset = this.repository.dataset(scope, key.domain);
    if (!query || !dataset || query.dataset_id !== dataset.id) return { items: [], complete: false, stale: true, needsValidation:true, validatedAt: null, changedAt: null, revision: dataset ? `${dataset.id}:${dataset.revision}:0` : 'unloaded' };
    const items = this.repository.sql.exec<{ id: string; kind: string; raw: string }>('SELECT r.id,r.kind,r.raw FROM source_members m JOIN resources r ON r.uid=m.uid AND r.domain=m.domain AND r.kind=m.kind AND r.id=m.resource_id WHERE m.uid=? AND m.domain=? AND m.query_key=? AND r.dataset_id=? ORDER BY m.position', scope.uid, key.domain, key.queryKey, dataset.id).toArray().map((row): ResourceRecord => ({ id: row.id, kind: row.kind as ResourceKind, raw: parseWire(row.raw) }));
    const complete = query.complete === 1 && query.invalidated === 0 && !this.repository.hasUncertainty(scope, key.domain);
    const needsValidation=query.complete!==1||query.invalidated!==0||query.validated_ms===null||this.clock.nowMs()-query.validated_ms>=60_000;
    return { items, complete, needsValidation, stale: !complete || needsValidation,
      validatedAt: query.validated_ms, changedAt: query.changed_ms, revision: `${dataset.id}:${dataset.revision}:${query.membership_revision}` };
  }
}
