import { createHash } from 'node:crypto';
import { isLosslessNumber } from 'lossless-json';
import type { ActorScope, Clock, Id } from '../shared/model';
import type { Problem } from '../shared/reply';
import { DomainError } from '../shared/errors';
import { parseWire, stringifyWire, type WireJson } from '../shared/wire-json';
import type { Repository } from '../storage/database';
import type { ItemState, MutationCommand, OperationItem, OperationState, OperationUpdate, OperationView, PreparedMutation, StoredOperation } from './contract';

type OperationRow = {
  id: string; uid: string; connection_epoch: string; request_id: string; action: string;
  input: string; digest: string; state: string; prepared: string | null; items: string;
  affected_ids: string; id_map: string; error: string | null; send_count: number;
};

function canonical(value: WireJson): WireJson {
  if (value === null || typeof value !== 'object' || isLosslessNumber(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key]!)]));
}
function rejectCredentials(value: WireJson): void {
  if (value === null || typeof value !== 'object' || isLosslessNumber(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:password|passwd|pwd|utoken|htoken|authorization|token|tok|passwordDigest)$/i.test(key)) throw new DomainError('CREDENTIAL_IN_OPERATION', '凭证不能保存为业务操作');
    if (item !== undefined) rejectCredentials(item);
  }
}
export function commandDigest(command: MutationCommand): string {
  rejectCredentials(command.input);
  return createHash('sha256').update(stringifyWire(canonical({ action: command.action, input: command.input }))).digest('hex');
}
export function operationView(operation: StoredOperation): OperationView {
  return { id: operation.id, action: operation.action, state: operation.state, items: operation.items,
    affectedIds: operation.affectedIds, idMap: operation.idMap, error: operation.error };
}
function decode(row: OperationRow): StoredOperation {
  const prepared = row.prepared === null ? null : parseWire(row.prepared) as unknown as PreparedMutation;
  return { id: row.id, scope: { uid: row.uid, connectionEpoch: row.connection_epoch }, requestId: row.request_id,
    action: row.action, input: parseWire(row.input), digest: row.digest, state: row.state as OperationState,
    prepared, items: JSON.parse(row.items) as OperationItem[], affectedIds: JSON.parse(row.affected_ids) as Id[],
    idMap: JSON.parse(row.id_map) as Record<Id, Id>, error: row.error === null ? null : JSON.parse(row.error) as Problem,
    sendCount: row.send_count };
}
function aggregate(items: readonly OperationItem[]): OperationState {
  if (items.length === 0) return 'failed';
  if (items.every((item) => item.state === 'succeeded')) return 'succeeded';
  if (items.every((item) => item.state === 'failed')) return 'failed';
  if (items.some((item) => item.state === 'succeeded')) return 'partial';
  return 'uncertain';
}
function encodePrepared(prepared: PreparedMutation): string {
  return stringifyWire({ payload: prepared.payload, affectedIds: [...prepared.affectedIds], affectedDomains: [...prepared.affectedDomains ?? []], items: prepared.items.map((item) => ({ id: item.id, affectedIds: [...item.affectedIds] })) });
}

export class OperationStore {
  constructor(readonly repository: Repository, private readonly clock: Clock) {}
  get(scope: ActorScope, id: Id): StoredOperation | null {
    this.repository.assertScope(scope);
    const row = this.repository.sql.exec<OperationRow>('SELECT * FROM operations WHERE uid=? AND id=?', scope.uid, id).toArray()[0];
    return row ? decode(row) : null;
  }
  find(scope: ActorScope, requestId: string): StoredOperation | null {
    this.repository.assertScope(scope);
    const row = this.repository.sql.exec<OperationRow>('SELECT * FROM operations WHERE uid=? AND request_id=?', scope.uid, requestId).toArray()[0];
    return row ? decode(row) : null;
  }
  create(command: MutationCommand, digest: string): StoredOperation {
    this.repository.assertScope(command.scope);
    const existing = this.find(command.scope, command.requestId);
    if (existing) {
      if (existing.digest !== digest) throw new DomainError('REQUEST_KEY_REUSED', '请求键已用于不同参数');
      return existing;
    }
    const id = crypto.randomUUID();
    this.repository.sql.exec('INSERT INTO operations(id,uid,connection_epoch,request_id,action,input,digest,state,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,\'queued\',?,?)',
      id, command.scope.uid, command.scope.connectionEpoch, command.requestId, command.action, stringifyWire(command.input), digest, this.clock.nowMs(), this.clock.nowMs()).toArray();
    return this.get(command.scope, id)!;
  }
  prepare(operation: StoredOperation, prepared: PreparedMutation): StoredOperation {
    this.repository.assertScope(operation.scope); rejectCredentials(prepared.payload);
    if (prepared.items.length === 0 || new Set(prepared.items.map((item) => item.id)).size !== prepared.items.length) throw new DomainError('INVALID_PREPARED_ITEMS', '操作必须包含明确且唯一的项目');
    const items: OperationItem[] = prepared.items.map((item) => ({ id: item.id, affectedIds: [...item.affectedIds], state: 'queued', error: null }));
    return this.repository.transaction(() => {
      this.repository.sql.exec('UPDATE operations SET prepared=?,items=?,affected_ids=?,updated_ms=? WHERE id=?',
        encodePrepared(prepared),
        JSON.stringify(items), JSON.stringify([...new Set(prepared.affectedIds)]), this.clock.nowMs(), operation.id).toArray();
      this.repository.sql.exec('DELETE FROM operation_domains WHERE operation_id=?', operation.id).toArray();
      for (const domain of new Set(prepared.affectedDomains ?? [])) this.repository.sql.exec('INSERT INTO operation_domains(operation_id,uid,domain) VALUES (?,?,?)', operation.id, operation.scope.uid, domain).toArray();
      return this.get(operation.scope, operation.id)!;
    });
  }
  markSending(operation: StoredOperation): StoredOperation {
    this.repository.assertScope(operation.scope);
    if (operation.sendCount !== 0 || operation.state !== 'queued') throw new DomainError('OPERATION_ALREADY_SENT', '操作已发送，需核查现有结果');
    const items = operation.items.map((item) => ({ ...item, state: 'sending' as const }));
    this.repository.sql.exec("UPDATE operations SET state='sending',items=?,send_count=send_count+1,error=NULL,updated_ms=? WHERE id=? AND send_count=0 AND state='queued'", JSON.stringify(items), this.clock.nowMs(), operation.id).toArray();
    for (const domain of new Set(operation.prepared?.affectedDomains ?? [])) this.repository.bumpSourceGeneration(operation.scope, domain);
    return this.get(operation.scope, operation.id)!;
  }
  markUnresolved(operation: StoredOperation, state: 'failed' | 'uncertain', error: Problem | null): StoredOperation {
    const items = operation.items.map((item) => item.state === 'succeeded' || item.state === 'failed' ? item : { ...item, state, error });
    this.repository.sql.exec('UPDATE operations SET state=?,items=?,error=?,updated_ms=? WHERE id=?', items.length ? aggregate(items) : state, JSON.stringify(items), error === null ? null : JSON.stringify(error), this.clock.nowMs(), operation.id).toArray();
    return this.get(operation.scope, operation.id)!;
  }
  checkpoint(operation: StoredOperation, prepared: PreparedMutation, update: OperationUpdate): StoredOperation {
    this.repository.assertScope(operation.scope); rejectCredentials(prepared.payload);
    if (!operation.prepared || prepared.items.length !== operation.items.length || new Set(prepared.items.map((item) => item.id)).size !== operation.items.length
      || prepared.items.some((item) => !operation.items.some((old) => old.id === item.id))) throw new DomainError('RECEIPT_ITEMS_INVALID', '批次检查点不能改变逻辑项目');
    const affectedIds = [...new Set([...operation.affectedIds, ...prepared.affectedIds])];
    const items = operation.items.map((item) => ({ ...item, affectedIds: [...new Set([...item.affectedIds, ...prepared.items.find((next) => next.id === item.id)!.affectedIds])] }));
    this.repository.sql.exec('UPDATE operations SET prepared=?,items=?,affected_ids=?,updated_ms=? WHERE id=?', encodePrepared(prepared), JSON.stringify(items), JSON.stringify(affectedIds), this.clock.nowMs(), operation.id).toArray();
    return this.apply(this.get(operation.scope, operation.id)!, update, true);
  }
  apply(operation: StoredOperation, update: OperationUpdate, checkpoint = false): StoredOperation {
    const updates = new Map(update.items.map((item) => [item.id, item]));
    if (update.items.length !== updates.size || update.items.some((item) => !operation.items.some((old) => old.id === item.id))) throw new DomainError('RECEIPT_ITEMS_INVALID', '回执项目不匹配');
    const items = operation.items.map((item) => {
      if (item.state === 'succeeded' || item.state === 'failed') return item;
      const next = updates.get(item.id);
      if (!next && checkpoint) return item;
      return { ...item, state: next?.state ?? 'uncertain' as ItemState, error: next?.error ?? null };
    });
    const state = checkpoint && items.some((item) => item.state === 'sending') ? 'sending' : aggregate(items);
    this.repository.sql.exec('UPDATE operations SET state=?,items=?,id_map=?,error=?,updated_ms=? WHERE id=?', state, JSON.stringify(items),
      JSON.stringify({ ...operation.idMap, ...update.idMap }), update.error ? JSON.stringify(update.error) : null, this.clock.nowMs(), operation.id).toArray();
    return this.get(operation.scope, operation.id)!;
  }
  setError(operation: StoredOperation, error: Problem): StoredOperation {
    this.repository.sql.exec('UPDATE operations SET error=?,updated_ms=? WHERE id=?', JSON.stringify(error), this.clock.nowMs(), operation.id).toArray();
    return this.get(operation.scope, operation.id)!;
  }
  interrupted(scope: ActorScope): StoredOperation[] {
    return this.repository.sql.exec<OperationRow>("SELECT * FROM operations WHERE uid=? AND connection_epoch=? AND state IN ('sending','verifying')", scope.uid, scope.connectionEpoch).toArray().map(decode);
  }
  queued(scope: ActorScope): StoredOperation[] {
    return this.repository.sql.exec<OperationRow>("SELECT * FROM operations WHERE uid=? AND connection_epoch=? AND state='queued' ORDER BY rowid", scope.uid, scope.connectionEpoch).toArray().map(decode);
  }
  conflict(operation: StoredOperation): boolean {
    const others = this.repository.sql.exec<{ items: string }>("SELECT items FROM operations WHERE uid=? AND id<>? AND state IN ('sending','verifying','uncertain','partial')", operation.scope.uid, operation.id).toArray();
    return others.some((row) => (JSON.parse(row.items) as OperationItem[]).some((item) => !['succeeded', 'failed'].includes(item.state) && item.affectedIds.some((id) => operation.affectedIds.includes(id))));
  }
}
