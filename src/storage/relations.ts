import type { ActorScope, Id } from '../shared/model';
import { parseWire, stringifyWire } from '../shared/wire-json';
import type { BillRelation } from './mirror';

type RelationRow = { kind: string; target_id: string; raw: string };
export function readRelations(sql: SqlStorage, scope: ActorScope, datasetId: Id, billId: Id): BillRelation[] {
  return sql.exec<RelationRow>(
    "SELECT kind,target_id,raw FROM bill_relations WHERE uid=? AND domain='ledger' AND dataset_id=? AND bill_id=? ORDER BY kind,target_id",
    scope.uid, datasetId, billId,
  ).toArray().map((row) => ({ kind: row.kind, targetId: row.target_id, raw: parseWire(row.raw) }));
}
export function replaceRelations(sql: SqlStorage, scope: ActorScope, datasetId: Id, billId: Id, relations: readonly BillRelation[]): void {
  sql.exec("DELETE FROM bill_relations WHERE uid=? AND domain='ledger' AND dataset_id=? AND bill_id=?", scope.uid, datasetId, billId).toArray();
  for (const relation of relations) {
    sql.exec('INSERT INTO bill_relations(uid,domain,dataset_id,bill_id,kind,target_id,raw) VALUES (?,\'ledger\',?,?,?,?,?)',
      scope.uid, datasetId, billId, relation.kind, relation.targetId, stringifyWire(relation.raw)).toArray();
  }
}
