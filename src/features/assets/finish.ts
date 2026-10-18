import type { ActorScope } from '../../shared/model';
import type { OperationContext } from '../../operations/contract';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { assetError, validateAsset } from './model';
export async function readCurrentAsset(ctx: OperationContext, scope: ActorScope, id: string) {
  const reply = await ctx.client.request('asset.info', { uid: scope.uid, did: id }, scope);
  return validateAsset(asBillObject(reply.data), scope, id);
}
export function ensureDebtAsset(type: string, status: string) {
  if (type !== '5' || !['0', '1'].includes(status)) return assetError('FINISH_TYPE_UNSUPPORTED', '仅支持未隐藏的借贷资产设置结清状态');
}
export function currentFinished(raw: ReturnType<typeof asBillObject>) { return numericText(raw.status, '0') === '1'; }
