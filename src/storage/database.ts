import type { ActorScope, Id } from '../shared/model';
import { parseWire, stringifyWire, type WireJson } from '../shared/wire-json';
import { DomainError } from '../shared/errors';
import { validateMoney } from '../shared/numbers';
import type { BillRecord, DatasetView, MirrorPage, SyncDomain } from './mirror';
import type { ResourceKind, ResourcePage, ResourceQuery } from './resources';
import { migrate } from './migrations';
import { readRelations, replaceRelations } from './relations';

type DatasetRow = { id: string; domain: string; revision: number; complete: number; validated_at: string | null };
type BillRow = { id: string; book_id: string; type: number; time_sec: number; money: string; raw: string };

function requireId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new DomainError('INVALID_ID', '业务ID不能为空');
}

export class Repository {
  readonly sql: SqlStorage;
  constructor(readonly storage: DurableObjectStorage) {
    migrate(storage);
    this.sql = storage.sql;
    this.transaction(() => {
      this.sql.exec('INSERT OR IGNORE INTO instance_meta(key,value) VALUES (?,?)', 'instance_id', crypto.randomUUID()).toArray();
      this.sql.exec('INSERT OR IGNORE INTO connection(singleton,device_id) VALUES (1,?)', crypto.randomUUID().replaceAll('-', '')).toArray();
    });
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(() => {
      const value = fn();
      if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
        throw new DomainError('ASYNC_TRANSACTION', 'SQLite事务不能跨异步调用');
      }
      return value;
    });
  }
  bindScope(scope: ActorScope): void {
    requireId(scope.uid); requireId(scope.connectionEpoch);
    this.sql.exec('UPDATE connection SET uid=?,connection_epoch=? WHERE singleton=1', scope.uid, scope.connectionEpoch).toArray();
  }
  assertScope(scope: ActorScope): void {
    const row = this.sql.exec<{ uid: string | null; connection_epoch: string | null }>('SELECT uid,connection_epoch FROM connection WHERE singleton=1').one();
    if (row.uid !== scope.uid || row.connection_epoch !== scope.connectionEpoch) throw new DomainError('STALE_CONNECTION', '连接已变更，请重新读取状态');
  }
  createDataset(scope: ActorScope, domain: SyncDomain, id: Id): void {
    this.assertScope(scope); requireId(id);
    this.transaction(() => {
      this.sql.exec('INSERT OR IGNORE INTO datasets(uid,domain,id) VALUES (?,?,?)', scope.uid, domain, id).toArray();
      this.sql.exec('INSERT OR IGNORE INTO sync_state(uid,domain,dataset_id) VALUES (?,?,?)', scope.uid, domain, id).toArray();
    });
  }
  dataset(scope: ActorScope, domain: SyncDomain): DatasetView | null {
    this.assertScope(scope);
    const row = this.sql.exec<DatasetRow>('SELECT d.id,d.domain,d.revision,d.complete,d.validated_at FROM datasets d JOIN active_datasets a ON a.uid=d.uid AND a.domain=d.domain AND a.dataset_id=d.id WHERE d.uid=? AND d.domain=?', scope.uid, domain).toArray()[0];
    return row ? { id: row.id, domain, revision: String(row.revision), complete: row.complete === 1, validatedAt: row.validated_at } : null;
  }
  applyPage(scope: ActorScope, datasetId: Id, page: MirrorPage, domain: SyncDomain = 'ledger'): void {
    this.assertScope(scope);
    this.transaction(() => {
      const dataset = this.sql.exec<DatasetRow>('SELECT id,domain,revision,complete,validated_at FROM datasets WHERE uid=? AND domain=? AND id=?', scope.uid, domain, datasetId).toArray()[0];
      if (!dataset) throw new DomainError('DATASET_MISSING', '同步数据集不存在');
      if (domain !== 'ledger' && (page.upserts.length || page.deletes.length)) throw new DomainError('WRONG_SYNC_DOMAIN', '账单只能写入账单数据集');
      let changed = false;
      for (const resource of page.resourceDeletes ?? []) {
        const deleted = this.sql.exec('DELETE FROM resources WHERE uid=? AND domain=? AND dataset_id=? AND kind=? AND id=?', scope.uid, domain, datasetId, resource.kind, resource.id);
        deleted.toArray(); changed = deleted.rowsWritten > 0 || changed;
        this.sql.exec('DELETE FROM source_members WHERE uid=? AND domain=? AND kind=? AND resource_id=? AND query_key IN (SELECT query_key FROM source_queries WHERE uid=? AND domain=? AND dataset_id=?)', scope.uid, domain, resource.kind, resource.id, scope.uid, domain, datasetId).toArray();
      }
      for (const id of page.deletes) {
        this.sql.exec("DELETE FROM bill_relations WHERE uid=? AND domain='ledger' AND dataset_id=? AND bill_id=?", scope.uid, datasetId, id).toArray();
        const deleted = this.sql.exec("DELETE FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND id=?", scope.uid, datasetId, id);
        deleted.toArray(); changed = deleted.rowsWritten > 0 || changed;
      }
      for (const bill of page.upserts) {
        requireId(bill.id); requireId(bill.bookId);
        validateMoney(bill.money, { maxScale: 100 });
        if (!Number.isSafeInteger(bill.type) || !Number.isSafeInteger(bill.timeSec)) throw new DomainError('INVALID_BILL_INDEX', '账单类型或时间无效');
        const previous = this.readBillFromDataset(scope, datasetId, bill.id);
        const oldText = previous && billText(previous);
        const newText = billText(bill);
        if (oldText === newText) continue;
        this.sql.exec("INSERT INTO bills(uid,domain,dataset_id,id,book_id,type,time_sec,money,raw) VALUES (?,'ledger',?,?,?,?,?,?,?) ON CONFLICT(uid,domain,dataset_id,id) DO UPDATE SET book_id=excluded.book_id,type=excluded.type,time_sec=excluded.time_sec,money=excluded.money,raw=excluded.raw",
          scope.uid, datasetId, bill.id, bill.bookId, bill.type, bill.timeSec, bill.money, stringifyWire(bill.raw)).toArray();
        replaceRelations(this.sql, scope, datasetId, bill.id, bill.relations);
        changed = true;
      }
      for (const resource of page.resources) {
        requireId(resource.id);
        const raw = stringifyWire(resource.raw);
        const previous = this.sql.exec<{ raw: string }>('SELECT raw FROM resources WHERE uid=? AND domain=? AND dataset_id=? AND kind=? AND id=?', scope.uid, domain, datasetId, resource.kind, resource.id).toArray()[0];
        if (previous?.raw === raw) continue;
        this.sql.exec('INSERT INTO resources(uid,domain,dataset_id,kind,id,raw) VALUES (?,?,?,?,?,?) ON CONFLICT(uid,domain,dataset_id,kind,id) DO UPDATE SET raw=excluded.raw', scope.uid, domain, datasetId, resource.kind, resource.id, raw).toArray();
        changed = true;
      }
      this.sql.exec('UPDATE datasets SET revision=revision+?,complete=?,validated_at=? WHERE uid=? AND domain=? AND id=?',
        changed ? 1 : 0, page.complete === undefined ? dataset.complete : Number(page.complete),
        page.validatedAt === undefined ? dataset.validated_at : page.validatedAt, scope.uid, domain, datasetId).toArray();
      if (changed) this.bumpSourceGeneration(scope, domain);
      const cursor = this.syncState(scope, domain, datasetId)?.cursor ?? null;
      this.sql.exec('UPDATE sync_state SET page_state=?,cursor=? WHERE uid=? AND domain=? AND dataset_id=?',
        stringifyWire(page.pageState), stringifyWire(page.cursor === undefined ? cursor : page.cursor), scope.uid, domain, datasetId).toArray();
    });
  }
  private readBillFromDataset(scope: ActorScope, datasetId: Id, id: Id): BillRecord | null {
    const row = this.sql.exec<BillRow>("SELECT id,book_id,type,time_sec,money,raw FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND id=?", scope.uid, datasetId, id).toArray()[0];
    return row ? { id: row.id, bookId: row.book_id, type: row.type, timeSec: row.time_sec, money: row.money, raw: parseWire(row.raw), relations: readRelations(this.sql, scope, datasetId, id) } : null;
  }
  readBill(scope: ActorScope, id: Id): BillRecord | null {
    const dataset = this.dataset(scope, 'ledger');
    return dataset ? this.readBillFromDataset(scope, dataset.id, id) : null;
  }
  readResources(scope: ActorScope, kind: ResourceKind, query: ResourceQuery): ResourcePage {
    const dataset = this.dataset(scope, query.domain);
    if (!dataset) return { items: [], nextCursor: null, revision: '0' };
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (query.ids && query.ids.length > 100)) throw new DomainError('INVALID_PAGE_SIZE', '查询数量超出范围');
    const filter = JSON.stringify({ kind, ids: query.ids ? [...new Set(query.ids)].sort() : null, limit });
    let after = '';
    if (query.cursor) {
      try {
        const cursor = JSON.parse(atob(query.cursor)) as { uid: string; domain: string; dataset: string; revision: string; filter: string; after: string };
        if (cursor.uid !== scope.uid || cursor.domain !== query.domain || cursor.dataset !== dataset.id || cursor.revision !== dataset.revision || cursor.filter !== filter || typeof cursor.after !== 'string') throw new Error();
        after = cursor.after;
      } catch { throw new DomainError('PAGE_CHANGED', '列表已变化，请从第一页重新读取'); }
    }
    if (query.ids?.length === 0) return { items: [], nextCursor: null, revision: dataset.revision };
    const bindings: SqlStorageValue[] = [scope.uid, query.domain, dataset.id, kind, after];
    let selectIds = '';
    if (query.ids) {
      selectIds = ` AND id IN (${query.ids.map(() => '?').join(',')})`;
      bindings.push(...query.ids);
    }
    const rows = this.sql.exec<{ id: string; raw: string }>(`SELECT id,raw FROM resources WHERE uid=? AND domain=? AND dataset_id=? AND kind=? AND id>?${selectIds} ORDER BY id LIMIT ?`, ...bindings, limit + 1).toArray();
    const items = rows.slice(0, limit).map((row) => ({ id: row.id, kind, raw: parseWire(row.raw) }));
    return {
      items, revision: dataset.revision,
      nextCursor: rows.length > limit ? btoa(JSON.stringify({ uid: scope.uid, domain: query.domain, dataset: dataset.id, revision: dataset.revision, filter, after: items.at(-1)!.id })) : null,
    };
  }
  switchDataset(scope: ActorScope, domain: SyncDomain, id: Id, cursor: WireJson): void {
    this.assertScope(scope);
    this.transaction(() => {
      const target = this.sql.exec<{ complete: number }>('SELECT complete FROM datasets WHERE uid=? AND domain=? AND id=?', scope.uid, domain, id).toArray()[0];
      if (target?.complete !== 1) throw new DomainError('DATASET_INCOMPLETE', '数据集尚未完整，保留原数据');
      this.sql.exec('INSERT INTO active_datasets(uid,domain,dataset_id) VALUES (?,?,?) ON CONFLICT(uid,domain) DO UPDATE SET dataset_id=excluded.dataset_id', scope.uid, domain, id).toArray();
      this.sql.exec('UPDATE sync_state SET cursor=? WHERE uid=? AND domain=? AND dataset_id=?', stringifyWire(cursor), scope.uid, domain, id).toArray();
    });
  }
  syncState(scope: ActorScope, domain: SyncDomain, id: Id): { pageState: WireJson; cursor: WireJson } | null {
    this.assertScope(scope);
    const row = this.sql.exec<{ page_state: string; cursor: string }>('SELECT page_state,cursor FROM sync_state WHERE uid=? AND domain=? AND dataset_id=?', scope.uid, domain, id).toArray()[0];
    return row ? { pageState: parseWire(row.page_state), cursor: parseWire(row.cursor) } : null;
  }
  saveDraft(scope: ActorScope, id: Id, raw: WireJson): void {
    this.assertScope(scope); requireId(id);
    this.transaction(()=>{
      if(/^(bill|asset|debt|budget|repeat|installment|saving):/.test(id)&&raw&&typeof raw==='object'&&!Array.isArray(raw)&&'requestId'in raw&&typeof raw.requestId==='string'){
        const contextId=`currency-context:${id}`,prior=this.readDraft(scope,contextId);
        if(!prior||typeof prior!=='object'||Array.isArray(prior)||!('requestId'in prior)||prior.requestId!==raw.requestId){
          const baseCurrency=this.sql.exec<{base_currency:string}>('SELECT base_currency FROM accounting_config WHERE uid=?',scope.uid).toArray()[0]?.base_currency??'CNY';
          this.sql.exec('INSERT INTO drafts(uid,id,raw) VALUES (?,?,?) ON CONFLICT(uid,id) DO UPDATE SET raw=excluded.raw',scope.uid,contextId,stringifyWire({requestId:raw.requestId,baseCurrency})).toArray();
        }
      }
      this.sql.exec('INSERT INTO drafts(uid,id,raw) VALUES (?,?,?) ON CONFLICT(uid,id) DO UPDATE SET raw=excluded.raw', scope.uid, id, stringifyWire(raw)).toArray();
    });
  }
  assertDraftCurrency(scope:ActorScope,requestId:string):void{
    this.assertScope(scope);
    const current=this.sql.exec<{base_currency:string}>('SELECT base_currency FROM accounting_config WHERE uid=?',scope.uid).toArray()[0]?.base_currency??'CNY';
    const contexts=this.sql.exec<{base_currency:string}>("SELECT json_extract(raw,'$.baseCurrency') AS base_currency FROM drafts WHERE uid=? AND id LIKE 'currency-context:%' AND json_extract(raw,'$.requestId')=?",scope.uid,requestId).toArray();
    const changed=contexts.find(row=>row.base_currency!==current);if(changed)throw new DomainError('DRAFT_CURRENCY_CHANGED',`草稿保存时本位币为${changed.base_currency}，当前为${current}。请重新载入资料、确认各项金额并建立新草稿`);
  }
  readDraft(scope: ActorScope, id: Id): WireJson | null {
    this.assertScope(scope);
    const row = this.sql.exec<{ raw: string }>('SELECT raw FROM drafts WHERE uid=? AND id=?', scope.uid, id).toArray()[0];
    return row ? parseWire(row.raw) : null;
  }
  sourceGeneration(scope: ActorScope, domain: SyncDomain): number {
    this.assertScope(scope);
    return this.sql.exec<{ generation: number }>('SELECT generation FROM source_domains WHERE uid=? AND domain=?', scope.uid, domain).toArray()[0]?.generation ?? 0;
  }
  bumpSourceGeneration(scope: ActorScope, domain: SyncDomain): void {
    this.assertScope(scope);
    this.sql.exec('INSERT INTO source_domains(uid,domain,generation) VALUES (?,?,1) ON CONFLICT(uid,domain) DO UPDATE SET generation=generation+1', scope.uid, domain).toArray();
  }
  hasUncertainty(scope: ActorScope, domain: SyncDomain): boolean {
    this.assertScope(scope);
    return this.sql.exec(`SELECT 1 FROM operation_domains d JOIN operations o ON o.id=d.operation_id WHERE d.uid=? AND d.domain=? AND o.state IN ('sending','verifying','uncertain','partial') AND EXISTS(SELECT 1 FROM json_each(o.items) WHERE json_extract(value,'$.state') IN ('sending','uncertain')) LIMIT 1`, scope.uid, domain).toArray().length > 0;
  }
  pruneInactiveDatasets(scope: ActorScope, domains: readonly SyncDomain[]): void {
    this.assertScope(scope);
    this.transaction(() => {
      for (const domain of new Set(domains)) {
        const unused = this.sql.exec<{ id: string }>(`SELECT d.id FROM datasets d WHERE d.uid=? AND d.domain=?
          AND NOT EXISTS(SELECT 1 FROM active_datasets a WHERE a.uid=d.uid AND a.domain=d.domain AND a.dataset_id=d.id)
          AND NOT EXISTS(SELECT 1 FROM sync_jobs s WHERE s.uid=d.uid AND s.domain=d.domain
            AND json_extract(CASE WHEN json_valid(s.checkpoint) THEN s.checkpoint ELSE '{}' END,'$.datasetId')=d.id
            AND (s.state='running' OR EXISTS(SELECT 1 FROM rebuild_jobs r WHERE r.id=json_extract(CASE WHEN json_valid(s.checkpoint) THEN s.checkpoint ELSE '{}' END,'$.ownerJobId') AND r.state='running')))`, scope.uid, domain).toArray();
        for (const { id } of unused) {
          this.sql.exec('DELETE FROM source_members WHERE uid=? AND domain=? AND query_key IN (SELECT query_key FROM source_queries WHERE uid=? AND domain=? AND dataset_id=?)', scope.uid, domain, scope.uid, domain, id).toArray();
          this.sql.exec('DELETE FROM source_queries WHERE uid=? AND domain=? AND dataset_id=?', scope.uid, domain, id).toArray();
          this.sql.exec('DELETE FROM bill_relations WHERE uid=? AND domain=? AND dataset_id=?', scope.uid, domain, id).toArray();
          this.sql.exec('DELETE FROM bills WHERE uid=? AND domain=? AND dataset_id=?', scope.uid, domain, id).toArray();
          this.sql.exec('DELETE FROM resources WHERE uid=? AND domain=? AND dataset_id=?', scope.uid, domain, id).toArray();
          this.sql.exec('DELETE FROM sync_state WHERE uid=? AND domain=? AND dataset_id=?', scope.uid, domain, id).toArray();
          this.sql.exec('DELETE FROM datasets WHERE uid=? AND domain=? AND id=?', scope.uid, domain, id).toArray();
        }
      }
    });
  }
}

function relationOrder(a: { kind: string; targetId: string }, b: { kind: string; targetId: string }): number {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
}
function billText(bill: BillRecord): string {
  return stringifyWire({ ...bill, relations: [...bill.relations].sort(relationOrder).map((relation) => ({ ...relation })) });
}
