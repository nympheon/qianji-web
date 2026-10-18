import { DomainError } from '../../shared/errors';
import { assertImageReferences } from '../attachments/references';
import type { ExpectedAssetEffect, MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import { asBillObject, billExtra, billLinks, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import { parseWire, stringifyWire, type WireJson } from '../../shared/wire-json';
import type { ActorScope } from '../../shared/model';
import { billVersion, restoreBillInput } from './write';
import { refundInputSchema } from './refund-contract';
import { loadTransferAsset } from './transfer';
import { projectBill } from '../sync/incremental';
import type { ProtocolReply } from '../../protocol/client';

const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
const numeric = (text: string) => new LosslessNumber(text);
export function nativeRefundCount(raw: BillObject): number {
  const extra = billExtra(raw);
  if (extra.rfds != null) return Object.keys(asBillObject(extra.rfds)).length;
  return compareMoney(moneyText(extra.refundv), '0') > 0 && positiveBillId(extra.refundsid) !== null ? 1 : 0;
}
export function nativeRefundTotal(raw: BillObject): string {
  const extra = billExtra(raw), refunds = extra.rfds == null ? {} : asBillObject(extra.rfds);
  if (Object.keys(refunds).length) return addMoney(...Object.values(refunds).map((value) => moneyText(value)));
  return compareMoney(moneyText(extra.refundv), '0') > 0 && positiveBillId(extra.refundid) !== null ? moneyText(extra.refundv) : '0';
}
function assetAmount(raw: BillObject): string {
  const extra = billExtra(raw), curr = extra.curr == null ? null : asBillObject(extra.curr);
  return curr && typeof curr.ts === 'string' && curr.ts ? moneyText(curr.tv) : moneyText(raw.money);
}
function sourceAmount(raw: BillObject): string {
  const extra = billExtra(raw), curr = extra.curr == null ? null : asBillObject(extra.curr);
  return curr ? moneyText(curr.sv) : moneyText(raw.money);
}
function matchesIntent(raw: BillObject, wire: BillObject): boolean {
  if (Number(numericText(raw.time, '0')) !== Number(numericText(wire.time, '0')) || compareMoney(sourceAmount(raw), moneyText(wire.money)) !== 0
    || numericText(raw.assetid, '-1') !== numericText(wire.assetid, '-1')) return false;
  if (!['remark', 'images'].every((key) => wire[key] === undefined || stringifyWire(wire[key]!) === stringifyWire(raw[key] ?? null))) return false;
  const extra = billExtra(raw);
  if (Array.isArray(wire.tags)) {
    const actual = Array.isArray(extra.tags) ? extra.tags : [];
    const sorted = (values: WireJson[]) => [...new Set(values.map((value) => numericText(value, '')))].sort();
    if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(wire.tags))) return false;
  }
  if (typeof wire.currency === 'string') {
    try {
      const expected = asBillObject(parseWire(wire.currency)), actual = asBillObject(extra.curr);
      if (!['ss', 'ts', 'bs'].every((key) => actual[key] === expected[key]) || !['sv', 'tv', 'bv'].every((key) => compareMoney(moneyText(actual[key]), moneyText(expected[key])) === 0)) return false;
    } catch { return false; }
  }
  return true;
}
type AssetBase = { assetId: string; currency: string; money: string };
interface Payload { scope: ActorScope; source: BillObject; oldRefund: BillObject | null; wire: BillObject; logicalId: string; preparedAt: string; assetBases: AssetBase[] }
function decode(prepared: PreparedMutation): Payload {
  const raw = asBillObject(prepared.payload), scope = asBillObject(raw.scope);
  if (typeof scope.uid !== 'string' || typeof scope.connectionEpoch !== 'string' || typeof raw.logicalId !== 'string' || typeof raw.preparedAt !== 'string' || !Array.isArray(raw.assetBases)) return fail('REFUND_OPERATION_INVALID', '退款操作记录无效');
  return { scope: { uid: scope.uid, connectionEpoch: scope.connectionEpoch }, source: asBillObject(raw.source), oldRefund: raw.oldRefund == null ? null : asBillObject(raw.oldRefund), wire: asBillObject(raw.wire), logicalId: raw.logicalId, preparedAt: raw.preparedAt,
    assetBases: raw.assetBases.map((value) => { const asset = asBillObject(value); if (typeof asset.assetId !== 'string' || typeof asset.currency !== 'string' || typeof asset.money !== 'string') return fail('REFUND_OPERATION_INVALID', '退款资产检查点无效'); return { assetId: asset.assetId, currency: asset.currency, money: asset.money }; }) };
}
function refundEffects(previous: BillObject | null, next: BillObject, bases: AssetBase[]): ExpectedAssetEffect[] {
  const deltas = new Map<string, string>();
  const add = (id: string | null, value: string) => { if (id) deltas.set(id, addMoney(deltas.get(id) ?? '0', value)); };
  if (previous) add(positiveBillId(previous.assetid), subtractMoney('0', assetAmount(previous)));
  add(positiveBillId(next.assetid), assetAmount(next));
  return [...deltas].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, delta]) => {
    const base = bases.find((base) => base.assetId === assetId); if (!base) return fail('REFUND_RECEIPT_INVALID', '回执资产与本次选择不匹配');
    return { assetId, currency: base.currency, delta, balanceBefore: base.money, expectedBalance: addMoney(base.money, delta), confirmation: 'expected' };
  });
}
function parseGroup(prepared: PreparedMutation, reply: ProtocolReply) {
  const payload = decode(prepared);
  if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length < 2 || reply.data.length > 200) return fail('REFUND_RECEIPT_INVALID', '退款回执缺少完整源与子记录');
  const records = reply.data.map(projectBill), source = records[0]!, child = records[1]!, sourceId = numericText(payload.source.id, '');
  const sourceLinks = billLinks(asBillObject(source.raw)).filter((link) => link.kind === 'refund');
  if (source.id !== sourceId || child.type !== 20 || child.bookId !== source.bookId || !sourceLinks.some((link) => link.targetId === child.id)
    || records.some((record) => numericText(asBillObject(record.raw).userid, payload.scope.uid) !== payload.scope.uid)
    || positiveBillId(billExtra(asBillObject(child.raw)).refundsid) !== sourceId || (payload.oldRefund && child.id !== numericText(payload.oldRefund.id, ''))
    || new Set(records.map((record) => record.id)).size !== records.length
    || records.some((record) => record.id !== sourceId && positiveBillId(billExtra(asBillObject(record.raw)).refundsid) !== sourceId)) return fail('REFUND_RECEIPT_INVALID', '退款回执的源子关联无法核对');
  if (!payload.oldRefund && billLinks(payload.source).some((link) => link.kind === 'refund' && link.targetId === child.id)) return fail('REFUND_RECEIPT_INVALID', '新增退款回执复用了已有子记录');
  if (numericText(payload.wire.assetid, '-1') !== numericText(asBillObject(child.raw).assetid, '-1') || compareMoney(sourceAmount(asBillObject(child.raw)), moneyText(payload.wire.money)) !== 0) return fail('REFUND_RECEIPT_INVALID', '退款回执的金额或资产与本次输入不匹配');
  return { payload, records, source, child };
}
export function createRefundMutationHandler(dependencies: { baseCurrency?: () => string; reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const input = refundInputSchema.parse(restoreBillInput(command.input)), scope = command.scope, repository = ctx.repository;
      if (!repository.dataset(scope, 'ledger')?.complete) return fail('LEDGER_INCOMPLETE', '请先完成账单同步');
      const source = repository.readBill(scope, input.billId); if (!source) return fail('BILL_NOT_LOADED', '源账单尚未载入');
      if (![0, 5].includes(source.type)) return fail('REFUND_TYPE_UNSUPPORTED', '只有普通支出和待报销支出支持退款');
      const rawSource = asBillObject(source.raw);
      if (numericText(rawSource.userid, '') !== scope.uid) return fail('REFUND_OTHER_USER', '不能为其他用户的账单新增或编辑退款');
      if (billVersion(source.raw) !== input.expectedVersion) return fail('DRAFT_SOURCE_CHANGED', '源账单已变化，请保留草稿并重新查看');
      const old = input.refundBillId ? repository.readBill(scope, input.refundBillId) : null, rawOld = old ? asBillObject(old.raw) : null;
      if (input.refundBillId && (!old || old.type !== 20 || !billLinks(rawSource).some((link) => link.kind === 'refund' && link.targetId === old.id) || positiveBillId(billExtra(asBillObject(old.raw)).refundsid) !== source.id)) return fail('REFUND_NOT_LINKED', '退款记录与源账单不匹配或尚未载入');
      if (old && billVersion(old.raw) !== input.refundExpectedVersion) return fail('DRAFT_SOURCE_CHANGED', '退款记录已变化，请重新查看');
      if (!old && billLinks(rawSource).some((link) => link.kind === 'refund') && nativeRefundCount(rawSource) >= 25) return fail('REFUND_COUNT_LIMIT', '该源账单已达到 APK 的25次退款上限');
      const categoryId = positiveBillId(rawSource.cateid);
      if (!categoryId || !repository.readResources(scope, 'category', { domain: 'ledger', ids: [categoryId] }).items.length) return fail('CATEGORY_NOT_LOADED', '源账单分类尚未载入');
      let amount = input.money ?? (rawOld ? sourceAmount(rawOld) : subtractMoney(source.money, nativeRefundTotal(rawSource)));
      if (!rawOld && compareMoney(amount, '0') <= 0) amount = subtractMoney(source.money, nativeRefundTotal(rawSource));
      if (compareMoney(amount, '0') <= 0) return fail('REFUND_AMOUNT_INVALID', '退款金额必须大于零');
      const baseCurrency = dependencies.baseCurrency?.() ?? 'CNY';
      const ids = [...new Set([input.assetId, rawOld ? positiveBillId(rawOld.assetid) : null].filter((value): value is string => !!value))];
      const assetBases = ids.map((id): AssetBase => { const asset = loadTransferAsset(ctx, scope, id, baseCurrency); if ([5, 6].includes(asset.type)) return fail('DEBT_ASSET_UNSUPPORTED', '退款不能使用借贷或汇总资产'); return { assetId: id, currency: asset.currency, money: asset.money }; });
      if (rawOld && positiveBillId(rawOld.assetid) && input.assetId === null) return fail('REFUND_CLEAR_UNVERIFIED', '退款移除关联资产的空值语义尚待真实验证');
      const sourceCurr = billExtra(rawSource).curr;
      if (!input.currency && (sourceCurr != null || assetBases.find((asset) => asset.assetId === input.assetId)?.currency !== undefined && assetBases.find((asset) => asset.assetId === input.assetId)?.currency !== baseCurrency)) return fail('REFUND_CURRENCY_REQUIRED', '请提供本次退款的历史币种金额');
      const wire: BillObject = { money: numeric(amount), time: input.timeSec };
      if (old) wire.billid = numeric(old.id);
      if (input.assetId) wire.assetid = numeric(input.assetId);
      if (input.currency) {
        const c = input.currency, sourceSymbol = sourceCurr == null ? baseCurrency : asBillObject(sourceCurr).ss;
        const targetSymbol = assetBases.find((asset) => asset.assetId === input.assetId)?.currency ?? baseCurrency;
        if (c.srcSymbol !== sourceSymbol || c.targetSymbol !== targetSymbol || c.baseSymbol !== baseCurrency || compareMoney(c.srcValue, amount) !== 0 || compareMoney(c.targetValue, '0') < 0 || compareMoney(c.baseValue, '0') < 0) return fail('REFUND_CURRENCY_INVALID', '退款历史币种与源金额、资产或本位币不匹配');
        wire.currency = stringifyWire({ ss: c.srcSymbol, sv: numeric(c.srcValue), ts: c.targetSymbol, tv: numeric(c.targetValue), bs: c.baseSymbol, bv: numeric(c.baseValue), srcFee: 0 });
      }
      const oldExtra = rawOld ? billExtra(rawOld) : {};
      const preserve = (field: 'remark' | 'images' | 'tags', incoming: string | string[] | undefined, previous: WireJson | undefined) => {
        const oldLength = typeof previous === 'string' || Array.isArray(previous) ? previous.length : 0;
        if (incoming !== undefined && incoming.length === 0 && oldLength > 0) return fail('REFUND_CLEAR_UNVERIFIED', '该退款字段的清空语义尚待真实验证，请保留原值');
        const value = incoming ?? previous;
        if ((typeof value === 'string' || Array.isArray(value)) && value.length) wire[field] = value;
      };
      preserve('remark', input.remark, rawOld?.remark); preserve('images', input.images, rawOld?.images); preserve('tags', input.tagIds, oldExtra.tags);
      for (const tag of input.tagIds ?? []) if (!repository.readResources(scope, 'tag', { domain: 'tags', ids: [tag] }).items.length) return fail('TAG_NOT_LOADED', '所选标签尚未载入');
      if (input.images !== undefined) assertImageReferences(ctx, scope, input.images, Array.isArray(rawOld?.images) ? rawOld.images.filter((value): value is string => typeof value === 'string') : []);
      const logicalId = old?.id ?? `refund:${command.requestId}`, affectedIds = [source.id, ...(old ? [old.id] : []), ...ids.map((id) => `asset:${id}`)];
      return { payload: { scope: { ...scope }, source: rawSource, oldRefund: rawOld, wire, logicalId, preparedAt: String(ctx.clock.nowMs()), assetBases: assetBases.map((asset) => ({ ...asset })) },
        items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ids.length ? ['ledger', 'assets'] : ['ledger'] };
    },
    send: async (prepared, ctx) => { const payload = decode(prepared); return ctx.client.request('bill.refund', { uid: payload.scope.uid, did: numericText(payload.source.id, ''), v: stringifyWire(payload.wire) }, payload.scope); },
    applyReceipt: (prepared, reply, ctx) => {
      const group = parseGroup(prepared, reply), repository = ctx.repository, dataset = repository.dataset(group.payload.scope, 'ledger');
      if (!dataset) return fail('DATASET_MISSING', '账单副本不存在');
      const affectedIds = [...group.records.map((record) => record.id), ...group.payload.assetBases.map((asset) => `asset:${asset.assetId}`)];
      const effects = refundEffects(group.payload.oldRefund, asBillObject(group.child.raw), group.payload.assetBases);
      repository.applyPage(group.payload.scope, dataset.id, { upserts: group.records, deletes: [], resources: [], pageState: repository.syncState(group.payload.scope, 'ledger', dataset.id)?.pageState ?? null });
      return { items: [{ id: group.payload.logicalId, state: 'succeeded', affectedIds, assetEffects: effects }], affectedIds, idMap: { [group.payload.logicalId]: group.child.id } };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared || !await dependencies.reconcileSource?.(ctx)) return { items: [] };
      const payload = decode(operation.prepared), repository = ctx.repository, dataset = repository.dataset(operation.scope, 'ledger');
      if (!dataset?.complete || !dataset.validatedAt || Date.parse(dataset.validatedAt) < Number(payload.preparedAt)) return { items: [] };
      const source = repository.readBill(operation.scope, numericText(payload.source.id, '')); if (!source) return { items: [] };
      const previous = new Set(billLinks(payload.source).filter((link) => link.kind === 'refund').map((link) => link.targetId));
      const possible = billLinks(asBillObject(source.raw)).filter((link) => link.kind === 'refund' && (payload.oldRefund ? link.targetId === numericText(payload.oldRefund.id, '') : !previous.has(link.targetId)))
        .map((link) => repository.readBill(operation.scope, link.targetId)).filter((record) => record !== null)
        .filter((record) => {
          const raw = asBillObject(record.raw);
          return record.type === 20 && matchesIntent(raw, payload.wire);
        });
      if (possible.length !== 1) return { items: [] };
      return { items: [], receipt: { ec: '200', httpStatus: 200, data: [source.raw, possible[0]!.raw] } };
    },
  };
}
