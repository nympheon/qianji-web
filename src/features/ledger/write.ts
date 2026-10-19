import { createHash } from 'node:crypto';
import { assertImageReferences } from '../attachments/references';
import { isLosslessNumber, LosslessNumber } from 'lossless-json';
import type { ExpectedAssetEffect, ItemUpdate, MutationCommand, MutationHandler, OperationContext, OperationUpdate, PreparedMutation } from '../../operations/contract';
import { DomainError } from '../../shared/errors';
import { asBillObject, billExtra, billLinks, moneyText, numericText, optionalWireId, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, newBillId, subtractMoney } from '../../shared/numbers';
import { stringifyWire, type WireJson } from '../../shared/wire-json';
import type { ActorScope } from '../../shared/model';
import type { ProtocolReply } from '../../protocol/client';
import { projectBill } from '../sync/incremental';
import { billChangesSchema, createBillsSchema, deleteBillsSchema, editBillsSchema, type BillChanges } from './write-contract';

export interface BillMutationEntry { logicalId: string; mode: 'create' | 'edit' | 'delete'; wire: BillObject; done: boolean; assetEffects?: ExpectedAssetEffect[]; affectedAssetIds?: string[] }
type Entry = BillMutationEntry;
interface Payload { scope: ActorScope; entries: Entry[]; preparedAt: string }
const numeric = (text: string) => new LosslessNumber(text);
const abs = (text: string) => text.startsWith('-') ? text.slice(1) : text;
const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
export function billVersion(raw: WireJson): string { return createHash('sha256').update(stringifyWire(raw)).digest('hex'); }
function decode(prepared: PreparedMutation): Payload {
  const payload = asBillObject(prepared.payload), scope = asBillObject(payload.scope);
  if (typeof scope.uid !== 'string' || typeof scope.connectionEpoch !== 'string' || !Array.isArray(payload.entries) || typeof payload.preparedAt !== 'string') return fail('BILL_OPERATION_INVALID', '账单操作记录无效');
  return { scope: { uid: scope.uid, connectionEpoch: scope.connectionEpoch }, preparedAt: payload.preparedAt,
    entries: payload.entries.map((value) => {
      const row = asBillObject(value);
      if (typeof row.logicalId !== 'string' || !['create', 'edit', 'delete'].includes(String(row.mode)) || typeof row.done !== 'boolean') return fail('BILL_OPERATION_INVALID', '账单操作项目无效');
      const effects = prepared.items.find((item) => item.id === row.logicalId)?.assetEffects;
      const affectedAssetIds = prepared.items.find((item) => item.id === row.logicalId)?.affectedIds.filter((id) => id.startsWith('asset:')).map((id) => id.slice(6));
      return { logicalId: row.logicalId, mode: row.mode as Entry['mode'], wire: asBillObject(row.wire), done: row.done, ...(effects ? { assetEffects: effects } : {}), ...(affectedAssetIds ? { affectedAssetIds } : {}) };
    }) };
}
function encode(payload: Payload, original?: PreparedMutation): PreparedMutation {
  const items = payload.entries.map((entry) => ({ id: entry.logicalId,
    affectedIds: [...new Set([entry.logicalId, numericText(entry.wire.id, ''), ...assetIds(entry.wire).map((id) => `asset:${id}`), ...entry.assetEffects?.map((effect) => `asset:${effect.assetId}`) ?? [], ...entry.affectedAssetIds?.map((id) => `asset:${id}`) ?? []])],
    ...(entry.assetEffects ? { assetEffects: entry.assetEffects } : {}) }));
  const entryIds = new Set(items.map((item) => item.id));
  const allItems = [...items, ...original?.items.filter((item) => !entryIds.has(item.id)) ?? []];
  const affectedIds = [...new Set([...original?.affectedIds ?? [], ...allItems.flatMap((item) => item.affectedIds)])];
  return { payload: { ...(original ? asBillObject(original.payload) : {}), scope: { ...payload.scope }, preparedAt: payload.preparedAt, entries: payload.entries.map(({ logicalId, mode, wire, done }) => ({ logicalId, mode, wire, done })) },
    items: allItems, affectedIds, affectedDomains: affectedIds.some((id) => id.startsWith('asset:')) ? ['ledger', 'assets'] : ['ledger'] };
}
function assetIds(raw: BillObject): string[] { return [raw.assetid, raw.fromid, raw.targetid].map((value) => numericText(value, '-1')).filter((value) => /^[1-9]\d*$/.test(value)); }
export function prepareBillEntries(scope: ActorScope, entries: BillMutationEntry[], preparedAtMs: number): PreparedMutation { return encode({ scope, entries, preparedAt: String(preparedAtMs) }); }
export function restoreBillInput(value: WireJson): unknown {
  if (isLosslessNumber(value)) {
    const integer = Number(value.value);
    if (!/^-?\d+$/.test(value.value) || !Number.isSafeInteger(integer)) return fail('INVALID_BILL_INPUT', '业务参数中的数字必须是安全整数，金额和 ID 请使用文本');
    return integer;
  }
  if (Array.isArray(value)) return value.map(restoreBillInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, WireJson] => pair[1] !== undefined).map(([key, child]) => [key, restoreBillInput(child)]));
  return value;
}
export function nextBillId(ctx: Pick<OperationContext, 'repository' | 'clock'>, scope: ActorScope, used: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = 100000 + crypto.getRandomValues(new Uint32Array(1))[0]! % 100000;
    const id = newBillId(BigInt(ctx.clock.nowMs()), suffix);
    if (!used.has(id) && !ctx.repository.readBill(scope, id)) { used.add(id); return id; }
  }
  return fail('BILL_ID_EXHAUSTED', '暂时无法生成未使用的账单 ID');
}
function resource(ctx: OperationContext, scope: ActorScope, kind: 'book' | 'category' | 'asset' | 'tag', id: string) {
  const domain = kind === 'book' ? 'books' : kind === 'asset' ? 'assets' : kind === 'tag' ? 'tags' : 'ledger';
  const row = ctx.repository.readResources(scope, kind, { domain, ids: [id] }).items[0];
  return row ? asBillObject(row.raw) : null;
}
function validateReferences(raw: BillObject, changes: BillChanges, ctx: OperationContext, scope: ActorScope) {
  const bookId = numericText(raw.bookid, ''), book = resource(ctx, scope, 'book', bookId);
  if (!book) return fail('BOOK_NOT_LOADED', '请先载入目标账本');
  const category = resource(ctx, scope, 'category', numericText(raw.cateid, ''));
  if (!category) return fail('CATEGORY_NOT_LOADED', '请先载入所选分类');
  const categoryBook = optionalWireId(category.bookid);
  if (categoryBook && categoryBook !== '-1' && categoryBook !== bookId) return fail('CATEGORY_BOOK_MISMATCH', '分类不属于目标账本');
  const categoryType = numericText(category.type, '-1'), type = numericText(raw.type, '');
  if (categoryType !== '-1' && categoryType !== (type === '5' ? '0' : type)) return fail('CATEGORY_TYPE_MISMATCH', '分类与账单类型不匹配');
  const assetId = numericText(raw.assetid, '-1');
  if (assetId !== '-1') {
    const asset = resource(ctx, scope, 'asset', assetId);
    if (!asset) return fail('ASSET_NOT_LOADED', '所选资产尚未载入');
    if (numericText(asset.type, '') === '5') return fail('DEBT_ASSET_UNSUPPORTED', '普通收支不能使用借贷资产');
  }
  for (const id of changes.tagIds ?? []) if (!resource(ctx, scope, 'tag', id)) return fail('TAG_NOT_LOADED', '所选标签尚未载入');
}
function buildBill(changes: BillChanges, raw: BillObject, ctx: OperationContext, scope: ActorScope, baseCurrency='CNY'): BillObject {
  const extra = { ...billExtra(raw) }, oldFee = moneyText(extra.transfee), type = changes.type ?? Number(numericText(raw.type, '0'));
  if (![0, 1, 5].includes(type)) return fail('BILL_TYPE_UNSUPPORTED', '请使用对应账单类型的专用操作');
  const fee = changes.fee ?? oldFee;
  if (compareMoney(fee, '0') > 0 || (type === 1 && compareMoney(fee, '0') !== 0)) return fail('ORDINARY_FEE_UNSUPPORTED', '普通收入不支持费用，普通支出仅支持负数优惠；手续费请使用转账操作');
  const financialChange = ['enteredMoney', 'fee', 'assetId', 'type', 'currency'].some((key) => Object.hasOwn(changes, key));
  if (extra.curr != null && financialChange && changes.currency===undefined) return fail('CURRENCY_EDIT_UNAVAILABLE', '历史多币种金额请使用已核验的多币种操作');
  if (financialChange) {
    const assetId=changes.assetId===null?'-1':changes.assetId??numericText(raw.assetid,'-1'),asset=assetId==='-1'?null:resource(ctx,scope,'asset',assetId),assetCurrency=asset&&typeof asset.currency==='string'&&asset.currency?asset.currency:baseCurrency,currency=changes.currency;
    if(!currency&&assetCurrency!==baseCurrency)return fail('CURRENCY_REQUIRED','此资产需要明确提供本次保存的历史币种金额');
    const entered = changes.enteredMoney ?? (extra.curr!=null?moneyText(asBillObject(extra.curr).sv):addMoney(moneyText(raw.money), abs(oldFee)));
    if (compareMoney(entered, '0') <= 0 || compareMoney(abs(fee), entered) > 0) return fail('BILL_AMOUNT_INVALID', '录入金额必须大于零，优惠不能超过录入金额');
    const net=subtractMoney(entered,abs(fee));
    if(currency){
      if(compareMoney(currency.srcValue,entered)!==0||currency.targetSymbol!==assetCurrency||currency.baseSymbol!==baseCurrency||compareMoney(currency.targetValue,'0')<0||compareMoney(currency.baseValue,'0')<0||currency.srcSymbol===currency.targetSymbol&&compareMoney(currency.targetValue,net)!==0||currency.srcSymbol===currency.baseSymbol&&compareMoney(currency.baseValue,net)!==0||currency.targetSymbol===currency.baseSymbol&&compareMoney(currency.targetValue,currency.baseValue)!==0)return fail('BILL_CURRENCY_INVALID','请确认原币录入额、优惠后的资产金额及本位币金额，币种须匹配所选资产和当前本位币');
      extra.curr={...(extra.curr==null?{}:asBillObject(extra.curr)),ss:currency.srcSymbol,sv:numeric(currency.srcValue),ts:currency.targetSymbol,tv:numeric(currency.targetValue),bs:currency.baseSymbol,bv:numeric(currency.baseValue)};
      // jd/n0.x0 uses targetValue as final money when a selected ordinary asset matches ts.
      raw.money=numeric(asset?currency.targetValue:net);
    }else{raw.money=numeric(net);if(changes.currency===null)delete extra.curr;}
    extra.transfee=numeric(fee);
  }
  raw.type = type; raw.userid = scope.uid; raw.status = 2; raw.updatetime = Math.floor(ctx.clock.nowMs() / 1000);
  if (changes.bookId !== undefined) raw.bookid = numeric(changes.bookId);
  if (changes.categoryId !== undefined) raw.cateid = numeric(changes.categoryId);
  if (changes.assetId !== undefined) raw.assetid = numeric(changes.assetId ?? '-1');
  if (changes.timeSec !== undefined) raw.time = changes.timeSec;
  if (changes.remark !== undefined) raw.remark = changes.remark;
  if (changes.images !== undefined) raw.images = assertImageReferences(ctx, scope, changes.images, Array.isArray(raw.images) ? raw.images.filter((value): value is string => typeof value === 'string') : []);
  if (changes.tagIds !== undefined) extra.tags = [...new Set(changes.tagIds)];
  let flag = BigInt(numericText(extra.flag, '0'));
  if (changes.countInStatistics !== undefined) flag = changes.countInStatistics ? flag & ~1n : flag | 1n;
  if (changes.countInBudget !== undefined) flag = changes.countInBudget ? flag & ~2n : flag | 2n;
  extra.flag = numeric(String(flag)); raw.extra = extra;
  validateReferences(raw, changes, ctx, scope);
  for (const key of ['category', 'fromact', 'targetact', 'paytype', 'bookname']) delete raw[key];
  return raw;
}
export function ensureBillUnrelated(raw: BillObject) {
  if (billLinks(raw).length || numericText(billExtra(raw).baoxiaoed, '0') === '1') return fail('RELATED_BILL_WRITE_UNAVAILABLE', '该账单有关联退款或报销，请使用对应关联操作');
}
interface BillReceipt { uid: string; added: Set<string>; updated: Set<string>; deleted: Set<string>; conflicts: Set<string> }
function parseReceipt(reply: ProtocolReply, batch: Entry[], scope: ActorScope): BillReceipt {
  const raw = asBillObject(asBillObject(asBillObject(reply.data).sync_result).bill);
  if (raw.userid !== scope.uid || typeof raw.has_failed !== 'boolean') return fail('BILL_RECEIPT_INVALID', '账单回执身份或结构无法核对');
  const requested = new Set(batch.map((entry) => numericText(entry.wire.id, ''))), seen = new Set<string>();
  const ids = (value: WireJson | undefined) => {
    if (value == null) return new Set<string>();
    if (!Array.isArray(value)) return fail('BILL_RECEIPT_INVALID', '账单回执集合无效');
    return new Set(value.map((value) => { const id = numericText(value, ''); if (!requested.has(id) || seen.has(id)) return fail('BILL_RECEIPT_INVALID', '账单回执包含非本批项目或重复项目'); seen.add(id); return id; }));
  };
  const result = { uid: scope.uid, added: ids(raw.new_ids), updated: ids(raw.update_ids), deleted: ids(raw.del_ids), conflicts: ids(raw.conf_ids) };
  for (const entry of batch) {
    const id = numericText(entry.wire.id, '');
    if ((entry.mode === 'delete' && (result.added.has(id) || result.updated.has(id))) || (entry.mode !== 'delete' && result.deleted.has(id))) return fail('BILL_RECEIPT_INVALID', '账单回执与操作类型不匹配');
  }
  return result;
}
function applyBatch(payload: Payload, batch: Entry[], receipt: BillReceipt, ctx: OperationContext): OperationUpdate {
  const repository = ctx.repository, dataset = repository.dataset(payload.scope, 'ledger');
  if (!dataset) return fail('DATASET_MISSING', '账单副本不存在');
  const success = batch.filter((entry) => receipt.added.has(numericText(entry.wire.id, '')) || receipt.updated.has(numericText(entry.wire.id, '')) || receipt.deleted.has(numericText(entry.wire.id, '')));
  repository.applyPage(payload.scope, dataset.id, { upserts: success.filter((entry) => entry.mode !== 'delete').map((entry) => projectBill({ ...entry.wire, status: 1, userid: receipt.uid })),
    deletes: success.filter((entry) => entry.mode === 'delete').map((entry) => numericText(entry.wire.id, '')), resources: [], pageState: repository.syncState(payload.scope, 'ledger', dataset.id)?.pageState ?? null });
  return { items: success.map((entry) => ({ id: entry.logicalId, state: 'succeeded' })) };
}
export function createLedgerMutationHandler(dependencies: { baseCurrency?:()=>string; reconcileSource?: (context: OperationContext) => Promise<boolean>; prepare?: (command: MutationCommand, context: OperationContext) => PreparedMutation | Promise<PreparedMutation> } = {}): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      if (dependencies.prepare) return dependencies.prepare(command, ctx);
      const scope = command.scope, used = new Set<string>(), entries: Entry[] = [];
      if (!ctx.repository.dataset(scope, 'ledger')?.complete) return fail('LEDGER_INCOMPLETE', '请先完成账单同步');
      if (command.action === 'ledger.create') {
        const input = createBillsSchema.parse(restoreBillInput(command.input));
        for (const bill of input.bills) {
          const id = nextBillId(ctx, scope, used), nowSec = Math.floor(ctx.clock.nowMs() / 1000);
          const raw: BillObject = { id: numeric(id), bookid: -1, cateid: 0, assetid: -1, fromid: -1, targetid: -1, money: 0, type: 0, time: nowSec, createtime: nowSec, updatetime: nowSec, status: 2, platform: 0, packid: 0, remark: '', extra: {} };
          entries.push({ logicalId: id, mode: 'create', wire: buildBill(bill, raw, ctx, scope, dependencies.baseCurrency?.()??'CNY'), done: false });
        }
      } else {
        const input = command.action === 'ledger.edit' ? editBillsSchema.parse(restoreBillInput(command.input)) : command.action === 'ledger.delete' ? deleteBillsSchema.parse(restoreBillInput(command.input)) : fail('BILL_ACTION_INVALID', '账单动作无效');
        for (const bill of input.bills) {
          if (used.has(bill.id)) return fail('DUPLICATE_BILL', '同批账单不能重复'); used.add(bill.id);
          const record = ctx.repository.readBill(scope, bill.id);
          if (!record) return fail('BILL_NOT_LOADED', '账单尚未载入');
          if (billVersion(record.raw) !== bill.expectedVersion) return fail('DRAFT_SOURCE_CHANGED', '云端副本已变化，请保留草稿并重新查看账单');
          const raw = { ...asBillObject(record.raw) };
          if (![0, 1, 5].includes(record.type)) return fail('BILL_TYPE_UNSUPPORTED', '请使用对应账单类型的专用操作');
          const changes = 'changes' in bill ? billChangesSchema.parse(bill.changes) : null;
          if (changes) {
            const links = billLinks(raw);
            if ((links.some((link) => link.kind.startsWith('reimbursement')) || numericText(billExtra(raw).baoxiaoed, '0') === '1') && changes.type !== undefined && changes.type !== record.type) return fail('REIMBURSEMENT_SOURCE_TYPE_LOCKED', '已有报销记录的源账单保留待报销类型');
            if (links.some((link) => link.kind === 'refund') && changes.type !== undefined && changes.type !== record.type) return fail('REFUND_SOURCE_TYPE_LOCKED', '已有退款的源账单不能切换类型');
          } else ensureBillUnrelated(raw);
          const affectedAssetIds = assetIds(raw);
          entries.push({ logicalId: bill.id, mode: changes ? 'edit' : 'delete', wire: changes ? buildBill(changes, raw, ctx, scope, dependencies.baseCurrency?.()??'CNY') : raw, done: false, affectedAssetIds });
        }
      }
      return encode({ scope, entries, preparedAt: String(ctx.clock.nowMs()) });
    },
    send: async (prepared, ctx) => {
      if (!ctx.checkpoint||!ctx.captureReceipt) return fail('BILL_EXECUTION_REQUIRED', '账单写入需要持久操作上下文');
      const payload = decode(prepared), used = new Set(prepared.affectedIds);
      let last: ProtocolReply = { ec: '200', data: {}, httpStatus: 200 };
      for (let iteration = 0; iteration < 5; iteration++) {
        const batch = payload.entries.filter((entry) => !entry.done).slice(0, 200);
        if (!batch.length) break;
        const v = stringifyWire({ bills: { changelist: batch.filter((entry) => entry.mode !== 'delete').map((entry) => entry.wire), dellist: batch.filter((entry) => entry.mode === 'delete').map((entry) => entry.wire.id!) } });
        last = await ctx.client.request('bill.syncall', { uid: payload.scope.uid, v }, payload.scope);
        ctx.captureReceipt(last,batch.map(entry=>entry.logicalId),batch.map(entry=>({logicalId:entry.logicalId,mode:entry.mode,wire:entry.wire,done:false})));
        const receipt = parseReceipt(last, batch, payload.scope), updates: ItemUpdate[] = [], idMap: Record<string, string> = {};
        for (const entry of batch) {
          const id = numericText(entry.wire.id, '');
          entry.done = true;
          if (receipt.conflicts.has(id)) {
            if (entry.mode === 'create' && iteration < 4) {
              const replacement = nextBillId(ctx, payload.scope, used); entry.wire = { ...entry.wire, id: numeric(replacement) }; entry.done = false;
              idMap[id] = replacement; idMap[entry.logicalId] = replacement;
            } else updates.push({ id: entry.logicalId, state: 'failed', error: { code: entry.mode === 'create' ? 'ID_CONFLICT_LIMIT' : 'EXISTING_ID_REJECTED', message: '钱迹明确拒绝该 ID，已停止原操作' } });
          } else if (!receipt.added.has(id) && !receipt.updated.has(id) && !receipt.deleted.has(id)) updates.push({ id: entry.logicalId, state: 'uncertain', error: { code: 'BILL_ACK_MISSING', message: '回执未确认该项目，请核查原操作' } });
        }
        // Use the sent records for receipt application; conflict replacements were never accepted.
        ctx.checkpoint(encode(payload, prepared), () => ({ items: [...applyBatch(payload, batch, receipt, ctx).items, ...updates], idMap }));
      }
      const remaining = payload.entries.filter((entry) => !entry.done);
      if (remaining.length) {
        remaining.forEach((entry) => { entry.done = true; });
        ctx.checkpoint(encode(payload, prepared), { items: remaining.map((entry) => ({ id: entry.logicalId, state: 'failed', error: { code: 'PUSH_BATCH_LIMIT', message: '本轮已达到 APK 的五批上限，该项目未发送' } })) });
      }
      return last;
    },
    // Historical reparse proves only the saved sent batch; the caller rolls canonical writes back.
    applyReceipt: (prepared,reply,ctx) => {
      const ids=prepared.received?.batchIds;if(!ids)return {items:[]};const payload=decode(prepared.received?.sentBatch?{...prepared,payload:{...asBillObject(prepared.payload),entries:prepared.received.sentBatch}}:prepared),batch=ids.map(id=>payload.entries.find(entry=>entry.logicalId===id));
      if(batch.some(entry=>!entry))return fail('BILL_RECEIPT_INVALID','持久批次与原逻辑项目不匹配');const entries=batch as Entry[],receipt=parseReceipt(reply,entries,payload.scope),update=applyBatch(payload,entries,receipt,ctx);
      return {items:[...update.items,...entries.filter(entry=>receipt.conflicts.has(numericText(entry.wire.id,''))).map(entry=>({id:entry.logicalId,state:'failed' as const,error:{code:'EXISTING_ID_REJECTED',message:'钱迹明确拒绝此ID；历史核查不再次发送'}}))]};
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] };
      const payload = decode(operation.prepared);
      if (!await dependencies.reconcileSource?.(ctx)) return { items: [] };
      const dataset = ctx.repository.dataset(operation.scope, 'ledger');
      if (!dataset?.complete || !dataset.validatedAt || Date.parse(dataset.validatedAt) < Number(payload.preparedAt)) return { items: [] };
      const items: ItemUpdate[] = [];
      for (const item of operation.items.filter((item) => item.state === 'uncertain' || item.state === 'sending')) {
        const entry = payload.entries.find((entry) => entry.logicalId === item.id)!;
        const record = ctx.repository.readBill(operation.scope, numericText(entry.wire.id, ''));
        if (entry.mode === 'delete') { if (!record) items.push({ id: item.id, state: 'succeeded' }); }
        else if (record && equivalentBusinessFields(asBillObject(record.raw), entry.wire)) items.push({ id: item.id, state: 'succeeded' });
      }
      return { items };
    },
  };
}
function equivalentBusinessFields(actual: BillObject, expected: BillObject): boolean {
  const equivalent = (actual: WireJson | undefined, expected: WireJson | undefined): boolean => {
    if (isLosslessNumber(expected) || typeof expected === 'number') {
      try { return compareMoney(moneyText(actual), moneyText(expected)) === 0; } catch { return false; }
    }
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => equivalent(actual[index], value));
    if (expected && typeof expected === 'object') {
      if (!actual || typeof actual !== 'object' || Array.isArray(actual) || isLosslessNumber(actual)) return false;
      return Object.entries(expected).every(([key, value]) => equivalent(actual[key], value));
    }
    return actual === expected;
  };
  const fields = ['id', 'bookid', 'type', 'time', 'money', 'cateid', 'assetid', 'fromid', 'targetid', 'remark', 'extra', 'images'];
  const unbound=(value:WireJson|undefined)=>value==null||['-1','0'].includes(numericText(value,''));
  return fields.every((key) => {
    if(!Object.hasOwn(expected,key))return true;
    if(['assetid','fromid','targetid'].includes(key)&&unbound(expected[key]))return unbound(actual[key]);
    return equivalent(key === 'extra' ? billExtra(actual) : actual[key], expected[key]);
  });
}
