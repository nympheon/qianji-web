import type { MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import { asBillObject, billExtra, billLinks, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import type { HistoricalCurrency } from './contract';
import { addMoney, compareMoney, divideMoney, multiplyMoney, subtractMoney } from '../../shared/numbers';
import { LosslessNumber } from 'lossless-json';
import { stringifyWire } from '../../shared/wire-json';
import { DomainError } from '../../shared/errors';
import { nativeRefundTotal } from './refund';
import { billVersion, createLedgerMutationHandler, prepareBillEntries, restoreBillInput } from './write';
import { cancelReimbursementInputSchema, reimburseInputSchema, reimbursableInputSchema } from './reimbursement-contract';
import { loadTransferAsset } from './transfer';
import { projectBill } from '../sync/incremental';
import type { ActorScope } from '../../shared/model';
import type { ProtocolReply } from '../../protocol/client';

const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
const num = (value: string) => new LosslessNumber(value);
const bxLinks = (raw: BillObject) => billLinks(raw).filter((link) => link.kind === 'reimbursement');
export function reimbursementRemaining(raw: BillObject): string {
  const extra = billExtra(raw), curr = extra.curr == null ? null : asBillObject(extra.curr), fee = moneyText(extra.transfee);
  const money = curr ? (compareMoney(fee, '0') < 0 ? addMoney(moneyText(curr.sv), fee) : subtractMoney(moneyText(curr.sv), fee)) : moneyText(raw.money);
  return subtractMoney(subtractMoney(money, nativeRefundTotal(raw)), addMoney(...bxLinks(raw).map((link) => moneyText(link.raw))));
}
/** APK BxPresenterImpl: time/long-ID order, clamp only non-last, final takes the residual. */
export function allocateReimbursement(sources: BillObject[], money: string, currency?: HistoricalCurrency): BillObject {
  if (!sources.length || compareMoney(money, '0') <= 0) return fail('REIMBURSEMENT_AMOUNT_INVALID', '报销金额必须大于零');
  const ordered = [...sources].sort((a, b) => {
    const time = BigInt(numericText(a.time, '0')) - BigInt(numericText(b.time, '0'));
    const difference = time || (BigInt(numericText(a.id, '0')) - BigInt(numericText(b.id, '0'))); return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
  let left = money, targetLeft = currency?.targetValue ?? '0', baseLeft = currency?.baseValue ?? '0';
  const targetRatio = currency ? divideMoney(currency.targetValue, currency.srcValue) : '0', baseRatio = currency ? divideMoney(currency.baseValue, currency.srcValue) : '0';
  const result: BillObject = {};
  ordered.forEach((source, index) => {
    const remaining = reimbursementRemaining(source), available = compareMoney(remaining, '0') > 0 ? remaining : '0';
    const last = index === ordered.length - 1, amount = last || compareMoney(left, available) < 0 ? left : available;
    const target = last ? targetLeft : multiplyMoney(amount, targetRatio), base = last ? baseLeft : multiplyMoney(amount, baseRatio);
    if (compareMoney(amount, '0') >= 0 && (!currency || compareMoney(target, '0') >= 0 && compareMoney(base, '0') >= 0)) result[numericText(source.id, '')] = currency
      ? { curr: { ss: currency.srcSymbol, sv: num(amount), ts: currency.targetSymbol, tv: num(target), bs: currency.baseSymbol, bv: num(base) } } : { money: num(amount) };
    else return fail('REIMBURSEMENT_ALLOCATION_INVALID', '历史币种分配产生负数，请重新核对金额');
    left = subtractMoney(left, amount); targetLeft = subtractMoney(targetLeft, target); baseLeft = subtractMoney(baseLeft, base);
  });
  return result;
}
interface Payload { scope: ActorScope; sources: BillObject[]; allocation: BillObject; wire: BillObject; assetId: string | null; logicalId: string; preparedAt: string; cancel: boolean }
function decode(prepared: PreparedMutation): Payload {
  const raw = asBillObject(prepared.payload), scope = asBillObject(raw.scope);
  if (typeof scope.uid !== 'string' || typeof scope.connectionEpoch !== 'string' || !Array.isArray(raw.sources) || typeof raw.logicalId !== 'string' || typeof raw.preparedAt !== 'string' || typeof raw.cancel !== 'boolean' || raw.assetId !== null && typeof raw.assetId !== 'string') return fail('REIMBURSEMENT_OPERATION_INVALID', '报销操作记录无效');
  return { scope: { uid: scope.uid, connectionEpoch: scope.connectionEpoch }, sources: raw.sources.map(asBillObject), allocation: asBillObject(raw.allocation), wire: asBillObject(raw.wire), assetId: raw.assetId, logicalId: raw.logicalId, preparedAt: raw.preparedAt, cancel: raw.cancel };
}
function allocationAmount(value: BillObject) { return value.curr == null ? moneyText(value.money) : moneyText(asBillObject(value.curr).sv); }
function childMatches(raw: BillObject, expected: BillObject, payload: Payload) {
  const curr = billExtra(raw).curr, amount = curr == null ? moneyText(raw.money) : moneyText(asBillObject(curr).sv);
  if (numericText(raw.assetid, '-1') !== (payload.assetId ?? '-1') || numericText(raw.time, '0') !== numericText(payload.wire.bxtime, '0') || compareMoney(amount, allocationAmount(expected)) !== 0) return false;
  if (expected.curr != null) {
    if (curr == null) return false;
    const a = asBillObject(curr), b = asBillObject(expected.curr);
    if (!['ss', 'ts', 'bs'].every((key) => a[key] === b[key]) || !['sv', 'tv', 'bv'].every((key) => compareMoney(moneyText(a[key]), moneyText(b[key])) === 0)) return false;
  }
  if (payload.wire.remark !== undefined && raw.remark !== payload.wire.remark) return false;
  if (payload.wire.tags !== undefined) {
    const tags = billExtra(raw).tags;
    if (!Array.isArray(tags) || typeof payload.wire.tags !== 'string') return false;
    if (JSON.stringify(tags.map((v) => numericText(v, '')).sort()) !== JSON.stringify((JSON.parse(payload.wire.tags) as string[]).sort())) return false;
  }
  return true;
}
function parseGroup(payload: Payload, reply: ProtocolReply) {
  const data = asBillObject(reply.data);
  if (!Array.isArray(data.bills) || data.bills.length > 1000) return fail('REIMBURSEMENT_RECEIPT_INVALID', '报销回执缺少完整账单组');
  const records = data.bills.map(projectBill), byId = new Map(records.map((bill) => [bill.id, bill]));
  if (byId.size !== records.length || records.some((record) => numericText(asBillObject(record.raw).userid, '') !== payload.scope.uid || ![5, 21].includes(record.type))) return fail('REIMBURSEMENT_RECEIPT_INVALID', '报销回执包含重复或不匹配记录');
  const childIds: string[] = [];
  for (const original of payload.sources) {
    const id = numericText(original.id, ''), source = byId.get(id);
    if (!source || source.type !== 5 || source.bookId !== numericText(original.bookid, '')) return fail('REIMBURSEMENT_RECEIPT_INVALID', '回执缺少原始待报销账单');
    const prior = new Set(bxLinks(original).map((link) => link.targetId)), added = bxLinks(asBillObject(source.raw)).filter((link) => !prior.has(link.targetId));
    if (added.length !== 1 || prior.size !== bxLinks(asBillObject(source.raw)).length - 1 || ![...prior].every((id) => bxLinks(asBillObject(source.raw)).some((link) => link.targetId === id))) return fail('REIMBURSEMENT_RECEIPT_INVALID', '源账单报销关系未完整保留');
    const child = byId.get(added[0]!.targetId), expected = asBillObject(payload.allocation[id]);
    if (!child || child.type !== 21 || child.bookId !== source.bookId || positiveBillId(billExtra(asBillObject(child.raw)).bxsid) !== id || !childMatches(asBillObject(child.raw), expected, payload) || compareMoney(moneyText(added[0]!.raw), allocationAmount(expected)) !== 0) return fail('REIMBURSEMENT_RECEIPT_INVALID', '报销子记录与分配意图不一致');
    childIds.push(child.id);
  }
  if (new Set(childIds).size !== childIds.length || records.some((record) => !payload.sources.some((source) => numericText(source.id, '') === record.id) && !childIds.includes(record.id))) return fail('REIMBURSEMENT_RECEIPT_INVALID', '回执包含本次报销组以外的记录');
  const asset = data.asset == null ? null : asBillObject(data.asset);
  if (asset && (positiveBillId(asset.id) !== payload.assetId || asset.money == null || asset.type == null)) return fail('REIMBURSEMENT_RECEIPT_INVALID', '报销入账资产无法核对');
  if (asset) moneyText(asset.money);
  return { records, childIds, asset };
}
export function createReimbursementMutationHandler(dependencies: { baseCurrency?: () => string; reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const cancel = command.action === 'ledger.cancelReimbursement', input = cancel ? cancelReimbursementInputSchema.parse(restoreBillInput(command.input)) : reimburseInputSchema.parse(restoreBillInput(command.input));
      const scope = command.scope, repository = ctx.repository;
      if (!repository.dataset(scope, 'ledger')?.complete) return fail('LEDGER_INCOMPLETE', '请先完成账单同步');
      if (new Set(input.bills.map((bill) => bill.id)).size !== input.bills.length) return fail('DUPLICATE_BILL', '待报销源账单不能重复');
      const sources = input.bills.map((bill) => {
        const record = repository.readBill(scope, bill.id); if (!record) return fail('BILL_NOT_LOADED', '待报销源账单尚未载入');
        const raw = asBillObject(record.raw);
        if (record.type !== 5) return fail('REIMBURSEMENT_TYPE_UNSUPPORTED', '请先将支出标记为待报销');
        if (numericText(raw.userid, '') !== scope.uid) return fail('REIMBURSEMENT_OTHER_USER', '不能操作其他用户的报销');
        if (billVersion(raw) !== bill.expectedVersion) return fail('DRAFT_SOURCE_CHANGED', '源账单已变化，请保留输入并重新查看');
        if (!bxLinks(raw).length && numericText(billExtra(raw).baoxiaoed, '0') === '1') return fail('LEGACY_REIMBURSEMENT_WRITE_UNVERIFIED', '旧版报销写入需先核对真实接口，保留原始数据');
        for (const link of bxLinks(raw)) {
          const child = repository.readBill(scope, link.targetId);
          if (!child || child.type !== 21 || positiveBillId(billExtra(asBillObject(child.raw)).bxsid) !== record.id) return fail('RELATED_BILL_MISSING', '关联报销记录未完整载入，请先同步');
        }
        return raw;
      });
      let assetId: string | null = null, allocation: BillObject = {}, wire: BillObject = {};
      const assetIds = new Set<string>();
      if (cancel) {
        if (sources.some((source) => !bxLinks(source).length)) return fail('REIMBURSEMENT_NOT_LINKED', '所选账单没有可取消的新版报销');
        for (const source of sources) for (const link of bxLinks(source)) { const child = repository.readBill(scope, link.targetId)!; const id = positiveBillId(asBillObject(child.raw).assetid); if (id) assetIds.add(id); }
        wire = { v: stringifyWire(sources.map((source) => num(numericText(source.id, '')))) };
      } else {
        const value = reimburseInputSchema.parse(input), base = dependencies.baseCurrency?.() ?? 'CNY';
        if (compareMoney(value.money, '0') <= 0) return fail('REIMBURSEMENT_AMOUNT_INVALID', '报销金额必须大于零');
        const symbols = new Set(sources.map((source) => billExtra(source).curr == null ? null : asBillObject(billExtra(source).curr).ss ?? null));
        if (symbols.size !== 1) return fail('REIMBURSEMENT_SOURCE_CURRENCIES', 'APK 不支持同时报销多种源币种');
        assetId = value.assetId;
        const asset = assetId ? loadTransferAsset(ctx, scope, assetId, base) : null;
        if (asset && [5, 6].includes(asset.type)) return fail('DEBT_ASSET_UNSUPPORTED', '报销不能使用借贷或汇总资产');
        if (assetId) assetIds.add(assetId);
        const symbol = [...symbols][0] || base;
        if (!value.currency && (symbol !== base || asset && asset.currency !== base)) return fail('REIMBURSEMENT_CURRENCY_REQUIRED', '请提供本次报销的三币种历史金额');
        const c = value.currency;
        if (c && (c.srcSymbol !== symbol || c.targetSymbol !== (asset?.currency ?? base) || c.baseSymbol !== base || compareMoney(c.srcValue, value.money) !== 0 || compareMoney(c.targetValue, '0') < 0 || compareMoney(c.baseValue, '0') < 0)) return fail('REIMBURSEMENT_CURRENCY_INVALID', '历史币种与源金额、资产或本位币不匹配');
        allocation = allocateReimbursement(sources, value.money, c); wire = { v: stringifyWire(allocation), bxtime: value.timeSec };
        if (assetId) wire.did = assetId;
        if (value.remark) wire.remark = value.remark;
        if (value.tagIds?.length) { for (const id of value.tagIds) if (!repository.readResources(scope, 'tag', { domain: 'tags', ids: [id] }).items.length) return fail('TAG_NOT_LOADED', '所选标签尚未载入'); wire.tags = JSON.stringify(value.tagIds); }
        if (value.images?.length) return fail('ATTACHMENT_UNVERIFIED', '图片上传完成验收后才能加入新报销');
      }
      const logicalId = `reimburse:${command.requestId}`, affectedIds = [...new Set([...sources.flatMap((source) => [numericText(source.id, ''), ...bxLinks(source).map((link) => link.targetId)]), ...[...assetIds].map((id) => `asset:${id}`)])];
      return { payload: { scope: { ...scope }, sources, allocation, wire, assetId, logicalId, preparedAt: String(ctx.clock.nowMs()), cancel }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: assetIds.size ? ['ledger', 'assets'] : ['ledger'] };
    },
    send: async (prepared, ctx) => { const p = decode(prepared); return ctx.client.request(p.cancel ? 'bill.cancelReimbursement' : 'bill.reimburse', { uid: p.scope.uid, ...p.wire }, p.scope); },
    applyReceipt: (prepared, reply, ctx) => {
      const p = decode(prepared);
      if (p.cancel) return { items: [{ id: p.logicalId, state: 'uncertain', error: { code: 'REIMBURSEMENT_CANCEL_CHECK', message: '钱迹已受理取消，待只读同步核对源关系、子记录和资产' } }] };
      const group = parseGroup(p, reply), repository = ctx.repository, ledger = repository.dataset(p.scope, 'ledger'), assets = repository.dataset(p.scope, 'assets');
      if (!ledger || group.asset && !assets) return fail('DATASET_MISSING', '报销回执对应的数据集尚未载入');
      repository.applyPage(p.scope, ledger.id, { upserts: group.records, deletes: [], resources: [], pageState: repository.syncState(p.scope, 'ledger', ledger.id)?.pageState ?? null });
      if (group.asset && assets) repository.applyPage(p.scope, assets.id, { upserts: [], deletes: [], resources: [{ id: p.assetId!, kind: 'asset', raw: group.asset }], pageState: repository.syncState(p.scope, 'assets', assets.id)?.pageState ?? null }, 'assets');
      const affectedIds = [...prepared.affectedIds, ...group.records.map((record) => record.id)];
      return { items: [{ id: p.logicalId, state: 'succeeded', affectedIds }], affectedIds, idMap: Object.fromEntries(p.sources.map((source, index) => [`${p.logicalId}:${numericText(source.id, '')}`, group.childIds[index]!])) };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared || !await dependencies.reconcileSource?.(ctx)) return { items: [] };
      const p = decode(operation.prepared), repository = ctx.repository, ledger = repository.dataset(p.scope, 'ledger');
      if (!ledger?.complete || !ledger.validatedAt || Date.parse(ledger.validatedAt) < Number(p.preparedAt)) return { items: [] };
      const sources = p.sources.map((source) => repository.readBill(p.scope, numericText(source.id, '')));
      if (sources.some((source) => !source || source.type !== 5)) return { items: [] };
      if (p.cancel) {
        const children = p.sources.flatMap((source) => bxLinks(source).map((link) => link.targetId));
        if (sources.some((source) => bxLinks(asBillObject(source!.raw)).length) || children.some((id) => repository.readBill(p.scope, id))) return { items: [] };
        if (operation.prepared.affectedDomains?.includes('assets')) { const assets = repository.dataset(p.scope, 'assets'); if (!assets?.complete || !assets.validatedAt || Date.parse(assets.validatedAt) < Number(p.preparedAt) || repository.sql.exec("SELECT 1 FROM source_queries WHERE uid=? AND domain='assets' AND invalidated=1 LIMIT 1", p.scope.uid).toArray().length) return { items: [] }; }
        return { items: [{ id: p.logicalId, state: 'succeeded' }] };
      }
      const children = sources.flatMap((source, index) => { const prior = new Set(bxLinks(p.sources[index]!).map((link) => link.targetId)); return bxLinks(asBillObject(source!.raw)).filter((link) => !prior.has(link.targetId)).map((link) => repository.readBill(p.scope, link.targetId)); });
      if (children.some((child) => !child)) return { items: [] };
      const receipt: ProtocolReply = { ec: '200', httpStatus: 200, data: { bills: [...sources.map((source) => source!.raw), ...children.map((child) => child!.raw)] } };
      try { parseGroup(p, receipt); } catch { return { items: [] }; }
      return { items: [], receipt };
    },
  };
}
export function createReimbursableMutationHandler(dependencies: { reconcileSource?: (ctx: OperationContext) => Promise<boolean> } = {}): MutationHandler {
  return createLedgerMutationHandler({ ...dependencies, prepare: (command, ctx) => {
    const input = reimbursableInputSchema.parse(restoreBillInput(command.input));
    if (!ctx.repository.dataset(command.scope, 'ledger')?.complete) return fail('LEDGER_INCOMPLETE', '请先完成账单同步');
    if (new Set(input.bills.map((bill) => bill.id)).size !== input.bills.length) return fail('DUPLICATE_BILL', '同批源账单不能重复');
    const entries = input.bills.map((bill) => {
      const row = ctx.repository.readBill(command.scope, bill.id); if (!row) return fail('BILL_NOT_LOADED', '源账单尚未载入');
      if (![0, 5].includes(row.type)) return fail('REIMBURSEMENT_TYPE_UNSUPPORTED', '只有普通支出支持待报销属性');
      const raw = { ...asBillObject(row.raw) };
      if (billVersion(raw) !== bill.expectedVersion) return fail('DRAFT_SOURCE_CHANGED', '源账单已变化，请重新查看');
      if (numericText(raw.userid, '') !== command.scope.uid) return fail('REIMBURSEMENT_OTHER_USER', '不能更改其他用户的报销属性');
      if (!input.reimbursable && (bxLinks(raw).length || numericText(billExtra(raw).baoxiaoed, '0') === '1')) return fail('REIMBURSEMENT_ATTRIBUTE_LOCKED', '已有报销记录时保留待报销属性，请先核对并取消报销');
      raw.type = input.reimbursable ? 5 : 0; raw.status = 2; raw.updatetime = Math.floor(ctx.clock.nowMs() / 1000);
      for (const key of ['category', 'fromact', 'targetact', 'paytype', 'bookname']) delete raw[key];
      return { logicalId: bill.id, mode: 'edit' as const, wire: raw, done: false };
    });
    return prepareBillEntries(command.scope, entries, ctx.clock.nowMs());
  } });
}
