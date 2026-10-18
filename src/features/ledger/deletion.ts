import type { ExpectedAssetEffect, ItemUpdate, MutationHandler, OperationContext, PreparedItem } from '../../operations/contract';
import { DomainError } from '../../shared/errors';
import { asBillObject, billExtra, billLinks, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { billVersion, createLedgerMutationHandler, prepareBillEntries, restoreBillInput, type BillMutationEntry } from './write';
import { deleteBillsSchema } from './write-contract';
import { loadTransferAsset } from './transfer';
import type { BillRecord } from '../../storage/mirror';
import type { WireJson } from '../../shared/wire-json';

const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
function deleteRefundIds(raw: BillObject): string[] {
  const extra = billExtra(raw), current = extra.rfds == null ? [] : Object.keys(asBillObject(extra.rfds)), legacy = positiveBillId(extra.refundid);
  return [...new Set([...current, ...(legacy && compareMoney(moneyText(extra.refundv), '0') > 0 ? [legacy] : [])])];
}
function deletionEffect(record: BillRecord, context: OperationContext, scope: { uid: string; connectionEpoch: string }, baseCurrency: string): ExpectedAssetEffect[] {
  const raw = asBillObject(record.raw), assetId = positiveBillId(raw.assetid); if (!assetId) return [];
  const asset = loadTransferAsset(context, scope, assetId, baseCurrency);
  let amount = record.money;
  if ([20, 21].includes(record.type)) {
    const curr = billExtra(raw).curr, extra = curr == null ? null : asBillObject(curr);
    if (extra && asset.currency !== extra.ss && typeof extra.ts === 'string' && extra.ts && compareMoney(moneyText(extra.tv), '0') > 0) amount = moneyText(extra.tv);
  }
  const deltas = new Map([[assetId, [0, 5].includes(record.type) ? amount : subtractMoney('0', amount)]]), extra = billExtra(raw);
  if (record.type === 5 && numericText(extra.baoxiaoed, '0') === '1') {
    const oldAsset = positiveBillId(extra.baoxiaoasset), value = moneyText(extra.baoxiaov, '-1'), oldMoney = compareMoney(value, '0') >= 0 ? value : record.money;
    if (oldAsset) deltas.set(oldAsset, subtractMoney(deltas.get(oldAsset) ?? '0', oldMoney));
  }
  return [...deltas].map(([id, delta]) => { const value = id === assetId ? asset : loadTransferAsset(context, scope, id, baseCurrency); return { assetId: id, currency: value.currency, delta, balanceBefore: value.money, expectedBalance: addMoney(value.money, delta), confirmation: 'expected' }; });
}
export function createLedgerDeletionHandler(dependencies: { baseCurrency?: () => string; reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  const base = createLedgerMutationHandler({ prepare: async (command, ctx) => {
    const input = deleteBillsSchema.parse(restoreBillInput(command.input)), scope = command.scope, repository = ctx.repository;
    if (!repository.dataset(scope, 'ledger')?.complete) return fail('LEDGER_INCOMPLETE', '请先完成账单同步');
    const records = new Map<string, BillRecord>();
    for (const item of input.bills) {
      if (records.has(item.id)) return fail('DUPLICATE_BILL', '同批账单不能重复');
      const record = repository.readBill(scope, item.id); if (!record) return fail('BILL_NOT_LOADED', '待删除账单尚未载入');
      if (billVersion(record.raw) !== item.expectedVersion) return fail('DRAFT_SOURCE_CHANGED', '待删除账单已变化，请重新查看');
      records.set(item.id, record);
    }
    const checks = new Map<string, Set<string>>(), sourceIds = new Set<string>();
    for (const record of records.values()) {
      const raw = asBillObject(record.raw);
      if (![0, 1, 5, 20, 21].includes(record.type)) return fail('BILL_TYPE_UNSUPPORTED', '该记录需要对应类型的专用删除操作');
      if ([0, 5].includes(record.type)) {
        for (const id of deleteRefundIds(raw)) {
          if (records.has(id)) continue;
          const child = repository.readBill(scope, id);
          if (!child || child.type !== 20 || positiveBillId(billExtra(asBillObject(child.raw)).refundsid) !== record.id) return fail('RELATED_BILL_MISSING', '关联退款尚未完整载入或关系不匹配，请先同步');
          if (records.size >= 1000) return fail('DELETE_BATCH_LIMIT', '展开关联记录后超过单次1000条上限');
          records.set(id, child);
        }
        for (const link of billLinks(raw).filter((link) => link.kind === 'reimbursement')) {
          if (records.has(link.targetId)) continue;
          const child = repository.readBill(scope, link.targetId);
          if (!child || child.type !== 21 || positiveBillId(billExtra(asBillObject(child.raw)).bxsid) !== record.id) return fail('RELATED_BILL_MISSING', '关联报销尚未完整载入或关系不匹配，请先同步');
          if (records.size >= 1000) return fail('DELETE_BATCH_LIMIT', '展开关联记录后超过单次1000条上限');
          records.set(child.id, child);
        }
      }
      if ([20, 21].includes(record.type)) {
        const sourceId = positiveBillId(billExtra(raw)[record.type === 20 ? 'refundsid' : 'bxsid']);
        if (!sourceId) return fail('RELATED_SOURCE_MISSING', '子记录缺少可核对的源ID');
        sourceIds.add(sourceId);
        if (!records.has(sourceId) && repository.readBill(scope, sourceId)) {
          const ids = checks.get(sourceId) ?? new Set<string>(); ids.add(record.id); checks.set(sourceId, ids);
        }
      }
    }
    for (const id of records.keys()) checks.delete(id);
    const entries: BillMutationEntry[] = [...records.values()].map((record) => ({ logicalId: record.id, mode: 'delete', wire: asBillObject(record.raw), done: false,
      assetEffects: deletionEffect(record, ctx, scope, dependencies.baseCurrency?.() ?? 'CNY') }));
    const prepared = prepareBillEntries(scope, entries, ctx.clock.nowMs());
    const verificationItems: PreparedItem[] = [...checks].map(([id, children]) => ({ id: `relations:${id}`, affectedIds: [id, ...children] }));
    return { ...prepared, payload: { ...asBillObject(prepared.payload), verifySources: [...checks].map(([sourceId, removedIds]) => ({ sourceId, removedIds: [...removedIds] })) },
      items: [...prepared.items, ...verificationItems], affectedIds: [...new Set([...prepared.affectedIds, ...sourceIds, ...verificationItems.flatMap((item) => item.affectedIds)])] };
  } });
  return { ...base, reconcile: async (operation, ctx) => {
    if (!operation.prepared || !await dependencies.reconcileSource?.(ctx)) return { items: [] };
    const payload = asBillObject(operation.prepared.payload), dataset = ctx.repository.dataset(operation.scope, 'ledger');
    if (!dataset?.complete || !dataset.validatedAt || Date.parse(dataset.validatedAt) < Number(numericText(payload.preparedAt, '0'))) return { items: [] };
    const items: ItemUpdate[] = [];
    for (const item of operation.items.filter((item) => item.state === 'uncertain' || item.state === 'sending')) {
      if (!item.id.startsWith('relations:')) {
        if (!ctx.repository.readBill(operation.scope, item.id)) items.push({ id: item.id, state: 'succeeded' });
        continue;
      }
      const sourceId = item.id.slice(10), check = (payload.verifySources as WireJson[]).map(asBillObject).find((check) => check.sourceId === sourceId);
      if (!check || !Array.isArray(check.removedIds)) continue;
      const ids = check.removedIds.map((id) => numericText(id, '')), source = ctx.repository.readBill(operation.scope, sourceId);
      const linked = source ? new Set(billLinks(asBillObject(source.raw)).filter((link) => ['refund', 'reimbursement'].includes(link.kind)).map((link) => link.targetId)) : new Set<string>();
      if (ids.every((id) => !linked.has(id) && !ctx.repository.readBill(operation.scope, id))) items.push({ id: item.id, state: 'succeeded' });
    }
    return { items };
  } };
}
