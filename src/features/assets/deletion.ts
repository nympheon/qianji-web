import type { ActorScope } from '../../shared/model';
import type { OperationContext } from '../../operations/contract';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { assetError } from './model';
import type { QianjiClient } from '../../protocol/client';
export interface AssetDeletionImpact { id: string; kind: 'delete' | 'detach' }
export function assetDeletionImpact(ctx: Pick<OperationContext, 'repository'>, scope: ActorScope, id: string): AssetDeletionImpact[] {
  const dataset = ctx.repository.dataset(scope, 'ledger'); if (!dataset?.complete) return assetError('LEDGER_INCOMPLETE', '删除资产前请完成账单同步，以便核对关联影响');
  const rows = ctx.repository.sql.exec<{ id: string; type: number }>("SELECT id,type FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND status_code<>0 AND (asset_id=? OR from_id=? OR target_id=?) LIMIT 1001", scope.uid, dataset.id, id, id, id).toArray();
  if (rows.length > 1000) return assetError('ASSET_DELETE_IMPACT_LIMIT', '关联账单超过单次核查范围，请先缩小数据或使用原生客户端处理');
  return rows.map((row) => {
    const raw = asBillObject(ctx.repository.readBill(scope, row.id)!.raw), asset = numericText(raw.assetid, '-1'), from = numericText(raw.fromid, '-1'), target = numericText(raw.targetid, '-1');
    const removed = [4, 6, 7, 9].includes(row.type) && asset === id || [10, 11].includes(row.type) && from === id || [2, 3].includes(row.type) && (from === id || target === id);
    return { id: row.id, kind: removed ? 'delete' : 'detach' };
  });
}
export async function assetDeleteDependencies(client: QianjiClient, scope: ActorScope, id: string, type: string) {
  if (type === '5') return { installCount: 0, repeatCount: 0, nativeCheckSkipped: true };
  const reply = await client.request('asset.deleteCheck', { uid: scope.uid, did: id }, scope), data = asBillObject(reply.data);
  const integer = (key: string) => { const value = Number(numericText(data[key], '0')); if (!Number.isSafeInteger(value) || value < 0) return assetError('ASSET_DELETE_CHECK_INVALID', '资产删除检查计数无效'); return value; };
  return { installCount: integer('installcount'), repeatCount: integer('repeatcount'), nativeCheckSkipped: false };
}
