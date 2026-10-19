import {resourceExisted} from '../../operations/identity';
import type { MutationHandler, OperationContext, PreparedMutation } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { assetError } from '../assets/model';
import { billVersion, restoreBillInput } from '../ledger/write';
import { bookDeleteSchema, bookQuitSchema, bookSubmitSchema, bookConfigureSchema, bookVisibleSchema, bookReorderSchema } from './contract';
import { bookView, parseBookDeleteCheck, validateBook } from './model';
import { refreshBooks } from './source';
import type { WireJson } from '../../shared/wire-json';
import { stringifyWire } from '../../shared/wire-json';
import { ResourceCache } from '../../storage/cache';
import { LosslessNumber } from 'lossless-json';
function decode(prepared: PreparedMutation) {
  const p = asBillObject(prepared.payload), s = asBillObject(p.scope);
  if (typeof s.uid !== 'string' || typeof s.connectionEpoch !== 'string' || typeof p.id !== 'string' || typeof p.logicalId !== 'string' || !['delete', 'quit', 'submit', 'configure', 'visible', 'reorder'].includes(String(p.kind))) return assetError('BOOK_OPERATION_INVALID', '账本操作日志无法识别');
  return { id: p.id, logicalId: p.logicalId, scope: { uid: s.uid, connectionEpoch: s.connectionEpoch }, kind: p.kind, params: asBillObject(p.params), self: p.self === true, create: p.create === true, noop: p.noop === true, desired: p.desired, expected: p.expected, raw: p.raw };
}
/** Only an authoritative delete/quit success or completed read proof may call this. */
function removeLocalBook(ctx: OperationContext, scope: ActorScope, id: string) {
  ctx.repository.assertScope(scope);
  const repository = ctx.repository, ledger = repository.dataset(scope, 'ledger'), books = repository.dataset(scope, 'books');
  if (ledger) {
    repository.sql.exec("DELETE FROM bill_relations WHERE uid=? AND domain='ledger' AND dataset_id=? AND bill_id IN (SELECT id FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND book_id=?)", scope.uid, ledger.id, scope.uid, ledger.id, id).toArray();
    const deleted = repository.sql.exec("DELETE FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND book_id=?", scope.uid, ledger.id, id); deleted.toArray();
    if (deleted.rowsWritten) repository.sql.exec("UPDATE datasets SET revision=revision+1 WHERE uid=? AND domain='ledger' AND id=?", scope.uid, ledger.id).toArray();
  }
  if (books) repository.applyPage(scope, books.id, { upserts: [], deletes: [], resources: [], resourceDeletes: [{ id, kind: 'book' }], pageState: repository.syncState(scope, 'books', books.id)?.pageState ?? null }, 'books');
}
export function createBookMutationHandler(): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const scope = command.scope, logicalId = `book:${command.requestId}`, parsed = restoreBillInput(command.input);
      if (command.action === 'books.submit' || command.action === 'books.configure') {
        const input = command.action === 'books.submit' ? bookSubmitSchema.parse(parsed) : bookConfigureSchema.parse(parsed), create = 'mode' in input && input.mode === 'create';
        let id = '-1', raw: import('../../shared/bill-wire').BillObject = {};
        if ('id' in input) {
          id = input.id; const current = (await refreshBooks(ctx, scope)).find((book) => book.id === id); if (!current) return assetError('BOOK_NOT_LOADED', '账本已不可访问'); raw = asBillObject(current.raw);
          if (billVersion(raw) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '账本资料已变化，请重新查看');
          if (command.action === 'books.submit' && bookView(raw, scope.uid).role !== 'owner') return assetError('BOOK_OWNER_REQUIRED', '只有所有者能编辑账本资料');
        }
        const configure = command.action === 'books.configure', value: import('../../shared/bill-wire').BillObject = {};
        if (configure) value.range = input.range!;
        else {
          const submit = bookSubmitSchema.parse(parsed), oldRange = bookView(raw, scope.uid).range;
          if (submit.mode === 'edit' && submit.range === '' && oldRange) return assetError('BOOK_RANGE_CLEAR_REQUIRES_CONFIG', '恢复自然月请使用设置账本业务周期，避免原生submit省略空range而保留旧周期');
          if (submit.mode === 'edit' && (submit.cover === null || submit.cover === '') && typeof raw.cover === 'string' && raw.cover) return assetError('BOOK_COVER_CLEAR_UNVERIFIED', '清空已有账本封面的上游语义尚未核验，请保留原封面');
          value.name = submit.name ?? raw.name;
          const cover = submit.cover === undefined ? raw.cover : submit.cover; if (cover !== null && cover !== undefined) value.cover = cover;
          if (submit.mode === 'create') value.type = submit.type; else value.bookid = new LosslessNumber(id);
          const range = submit.range ?? bookView(raw, scope.uid).range; if (range) value.range = range;
        }
        const affectedIds = [create ? 'book-catalog' : `book:${id}`];
        return { payload: { scope: { ...scope }, id, logicalId, kind: configure ? 'configure' : 'submit', create, expected: value, raw, params: { uid: scope.uid, ...(configure ? { did: id } : {}), v: stringifyWire(value) } }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['books', 'ledger', 'budget'] };
      }
      if (command.action === 'books.setVisible' || command.action === 'books.reorder') {
        const list = await refreshBooks(ctx, scope);
        if (command.action === 'books.reorder') {
          const input = bookReorderSchema.parse(parsed); if (new Set(input.ids).size !== input.ids.length || input.ids.some((id) => !list.some((book) => book.id === id))) return assetError('BOOK_ORDER_INVALID', '排序列表包含重复或未载入的账本');
          const affectedIds = input.ids.map((id) => `book:${id}`); return { payload: { scope: { ...scope }, id: 'order', logicalId, kind: 'reorder', expected: input.ids, params: { uid: scope.uid, v: stringifyWire(input.ids.map((id) => new LosslessNumber(id))) } }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['books'] };
        }
        const input = bookVisibleSchema.parse(parsed), item = list.find((book) => book.id === input.id); if (!item) return assetError('BOOK_NOT_LOADED', '账本已不可访问');
        const book = bookView(asBillObject(item.raw), scope.uid), affectedIds = [`book:${input.id}`];
        return { payload: { scope: { ...scope }, id: input.id, logicalId, kind: 'visible', desired: input.visible, noop: book.visible === input.visible, raw: item.raw, params: { uid: scope.uid, bookid: input.id } }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: ['books', 'ledger', 'budget'] };
      }
      const quit = command.action === 'books.quit'; if (!quit && command.action !== 'books.delete') return assetError('BOOK_ACTION_UNSUPPORTED', '该账本动作尚未实现');
      const input = quit ? bookQuitSchema.parse(parsed) : bookDeleteSchema.parse(parsed);
      if (input.id === '-1') return assetError('DEFAULT_BOOK_PROTECTED', '默认账本不能删除或退出');
      const list = await refreshBooks(ctx, scope), raw = list.find((item) => item.id === input.id)?.raw; if (!raw) return assetError('BOOK_NOT_LOADED', '目标账本已不可访问，请刷新列表');
      if (billVersion(raw) !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '账本资料已变化，请重新核对');
      const book = bookView(raw, scope.uid), memberId = 'memberId' in input ? input.memberId : null;
      if (!quit && book.role !== 'owner') return assetError('BOOK_OWNER_REQUIRED', '只有账本所有者能删除云端账本');
      if (quit && !(book.role === 'member' && memberId === scope.uid || book.role === 'owner' && memberId !== book.ownerId)) return assetError('BOOK_QUIT_NOT_ALLOWED', '参与者只能退出本人，所有者不能通过退出替代删除账本');
      if (quit && memberId !== scope.uid) {
        const reply = await ctx.client.request('book.members', { uid: scope.uid, bookid: input.id }, scope);
        if (!Array.isArray(reply.data) || reply.hasMore || !reply.data.some((member) => numericText(asBillObject(member).id, '') === memberId)) return assetError('BOOK_MEMBER_NOT_LOADED', '当前成员名单不包含目标成员');
      }
      if (!quit) { const check = await ctx.client.request('book.deleteCheck', { uid: scope.uid, bookid: input.id }, scope); if (parseBookDeleteCheck(asBillObject(check.data)).blocked) return assetError('BOOK_UNRESOLVED', '账本仍有本人或成员未结事项，请先处理后再删除'); }
      const self = !quit || memberId === scope.uid, affectedIds = [`book:${input.id}`];
      return { payload: { scope: { ...scope }, id: input.id, logicalId, kind: quit ? 'quit' : 'delete', params: { uid: scope.uid, bookid: input.id, ...(quit ? { v: String(memberId) } : {}) }, self }, items: [{ id: logicalId, affectedIds }], affectedIds, affectedDomains: self ? ['books', 'ledger', 'assets', 'budget', 'repeat', 'installments', 'savings'] : ['books'] };
    },
    send: async (prepared, ctx) => { const p = decode(prepared); if (p.noop) return { ec: '200', httpStatus: 200, data: p.raw ?? null }; const op = p.kind === 'delete' ? 'book.delete' : p.kind === 'quit' ? 'book.quit' : p.kind === 'submit' ? 'book.submit' : p.kind === 'configure' ? 'book.configure' : p.kind === 'visible' ? 'book.visible' : 'book.reorder'; return ctx.client.request(op, p.params, p.scope); },
    applyReceipt: (prepared, reply, ctx) => {
      const p = decode(prepared);
      if (p.kind === 'visible' || p.kind === 'reorder') return { items: [{ id: p.logicalId, state: p.noop ? 'succeeded' : 'uncertain', ...(p.noop ? {} : { error: { code: 'BOOK_TARGET_CHECK', message: '账本请求已受理，需只读核对实际状态' } }) }] };
      if (p.kind === 'submit' || p.kind === 'configure') {
        const raw = validateBook(asBillObject(reply.data), p.create ? undefined : p.id), id = numericText(raw.bookid, ''), expected = asBillObject(p.expected);
        if (p.create && (id === '-1' || numericText(raw.userid, '') !== p.scope.uid || resourceExisted(prepared,ctx.repository,p.scope,'books','book',id,ctx.validatingHistoricalReceipt))) return assetError('BOOK_NEW_ID_INVALID', '新增账本回执复用了ID或不属于当前用户');
        const nameTruncated=typeof expected.name==='string'&&expected.name.length>15&&raw.name===expected.name.slice(0,15)&&matchesBook(raw,{...expected,name:raw.name});
        if (!matchesBook(raw, expected)&&!nameTruncated) return assetError('BOOK_RECEIPT_INVALID', '账本回执与本次名称、类型、封面或账期不一致');
        new ResourceCache(ctx.repository, ctx.clock).confirmResources(p.scope, 'books', [{ id, kind: 'book', raw }]); const affectedIds = [...prepared.affectedIds, `book:${id}`]; return { items: [{ id: p.logicalId, state: nameTruncated?'failed':'succeeded', affectedIds, ...(nameTruncated?{error:{code:'BOOK_NAME_TRUNCATED',message:'钱迹已保存账本，但名称被截短；请查看已返回账本，不要重新创建'}}:{}) }], affectedIds, ...(p.create ? { idMap: { [p.logicalId]: id } } : {}) };
      }
      if (p.self) removeLocalBook(ctx, p.scope, p.id); return { items: [{ id: p.logicalId, state: 'succeeded' }] };
    },
    reconcile: async (operation, ctx) => {
      if (!operation.prepared) return { items: [] }; const p = decode(operation.prepared);
      if (p.create) return { items: [] };
      const list: { id: string; raw: WireJson }[] = await refreshBooks(ctx, p.scope);
      if (p.kind === 'visible') { const row = list.find((book) => book.id === p.id); return row && bookView(asBillObject(row.raw), p.scope.uid).visible === p.desired ? { items: [{ id: p.logicalId, state: 'succeeded' }] } : { items: [] }; }
      if (p.kind === 'reorder') { const ids = Array.isArray(p.expected) ? p.expected.map((id) => numericText(id, '')) : []; return ids.length && JSON.stringify(list.filter((book) => ids.includes(book.id)).map((book) => book.id)) === JSON.stringify(ids) ? { items: [{ id: p.logicalId, state: 'succeeded' }] } : { items: [] }; }
      if (p.kind === 'submit' || p.kind === 'configure') { const row = list.find((book) => book.id === p.id); return row && matchesBook(asBillObject(row.raw), asBillObject(p.expected)) ? { items: [{ id: p.logicalId, state: 'succeeded' }] } : { items: [] }; }
      if (p.self) { if (list.some((item) => item.id === p.id)) return { items: [] }; ctx.repository.transaction(() => removeLocalBook(ctx, p.scope, p.id)); return { items: [{ id: p.logicalId, state: 'succeeded' }] }; }
      const reply = await ctx.client.request('book.members', { uid: p.scope.uid, bookid: p.id }, p.scope);
      if (!Array.isArray(reply.data) || reply.hasMore || reply.data.some((value) => numericText(asBillObject(value).id, '') === p.params.v)) return { items: [] };
      return { items: [{ id: p.logicalId, state: 'succeeded' }] };
    },
  };
}
function matchesBook(raw: import('../../shared/bill-wire').BillObject, expected: import('../../shared/bill-wire').BillObject): boolean {
  for (const key of ['name', 'cover', 'type']) if (expected[key] !== undefined && numericText(raw[key], '') !== numericText(expected[key], '')) return false;
  return expected.range === undefined || bookView(raw, '').range === expected.range;
}
