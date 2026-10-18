import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { bookView, parseBookDeleteCheck } from '../../src/features/books/model';
import { BookService } from '../../src/features/books/service';
import { createBookMutationHandler } from '../../src/features/books/use-cases';
import { Coordinator } from '../../src/actor/coordinator';
import { ResourceCache } from '../../src/storage/cache';
import { billVersion } from '../../src/features/ledger/write';
import { stringifyWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import { asBillObject, numericText } from '../../src/shared/bill-wire';
import { parseWire } from '../../src/shared/wire-json';
import { createQueryPlan } from '../../src/features/ledger/query';
import { AccountingConfiguration, createAccountingConfigurationHandler } from '../../src/features/books/accounting';
import { billChangesSchema } from '../../src/features/ledger/write-contract';
import { transferFieldsSchema } from '../../src/features/ledger/transfer-contract';
import { createDebtSchema } from '../../src/features/debt/contract';
const owned = { bookid: '10', name: '测试自建账本', userid: 'user-A', memberid: 'user-A', type: 1, visible: 1, sort: 0, expired: 0, membercount: 1, config: { range: 'm10' } };
const joined = { ...owned, bookid: '20', name: '测试参与账本', userid: 'other-owner', memberid: 'user-A', visible: 0, sort: 1, expired: 1 };
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope), books = [{ ...owned, userid: app.scope.uid, memberid: app.scope.uid }, { ...joined, memberid: app.scope.uid }];
  await app.repository((r) => { r.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); for (const domain of ['books', 'ledger'] as const) { r.createDataset(app.scope, domain, domain); r.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? [projectBill({ id: '1', bookid: '10', type: 0, money: '100', time: 1 }), projectBill({ id: '2', bookid: '20', type: 0, money: '50', time: 1 })] : [], deletes: [], resources: domain === 'books' ? books.map((raw) => ({ id: raw.bookid, kind: 'book', raw })) : [], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain); r.switchDataset(app.scope, domain, domain, null); } });
  upstream.respond(async () => { const call = upstream.calls.at(-1)!; if (call.url.includes('/book/list')) return new Response(stringifyWire({ ec: 200, data: { list: books } })); if (call.url.includes('/book/deletecheck')) return new Response('{"ec":200,"data":{"owner_has_unresolved":0,"member_has_unresolved":0}}'); return new Response('{"ec":200,"data":{"v":1}}'); });
  const run = <T>(fn: (c: Coordinator) => Promise<T>) => app.repository((repository) => { const handler = createBookMutationHandler(); return fn(new Coordinator({ repository, client: upstream.client, clock }, new Map(['books.delete', 'books.quit', 'books.setVisible', 'books.submit', 'books.configure', 'books.reorder'].map((action) => [action, handler])))); });
  return { app, clock, upstream, books, run };
}
describe('native book identity and deletion checks', () => {
  it('accepts native bookId-1 in business contracts while keeping asset and bill IDs positive', () => {
    expect(billChangesSchema.safeParse({ bookId: '-1' }).success).toBe(true);
    expect(transferFieldsSchema.safeParse({ bookId: '-1', fromAssetId: '10', targetAssetId: '20', enteredMoney: '1', fee: '0', timeSec: 1 }).success).toBe(true);
    expect(createDebtSchema.safeParse({ direction: 'borrow', name: 'test', principal: '1', bookId: '-1', startDate: '2026-01-01', inCount: true }).success).toBe(true);
    expect(billChangesSchema.safeParse({ assetId: '-1' }).success).toBe(false);
  });
  it('preserves owner/member expiry separately and never treats the default book as an expired owner book', () => {
    expect(bookView(owned, 'user-A', true)).toMatchObject({ role: 'owner', expiredAsOwner: true, expiredAsMember: false, defaultBook: false, range: 'm10' });
    expect(bookView(joined, 'user-A', false)).toMatchObject({ role: 'member', expiredAsOwner: false, expiredAsMember: true, visible: false });
    expect(bookView({ ...owned, bookid: '-1' }, 'user-A', true)).toMatchObject({ defaultBook: true, expiredAsOwner: false });
    expect(bookView(owned, 'unrelated', false)).toMatchObject({ role: 'unknown' });
  });
  it('uses legacy unresolved only when both new fields are absent, retaining separate owner/member flags', () => {
    expect(parseBookDeleteCheck({ has_unresolved: 1 })).toEqual({ ownerHasUnresolved: true, memberHasUnresolved: true, blocked: true });
    expect(parseBookDeleteCheck({ owner_has_unresolved: 0, member_has_unresolved: 0, has_unresolved: 1 })).toEqual({ ownerHasUnresolved: false, memberHasUnresolved: false, blocked: false });
    expect(parseBookDeleteCheck({ member_has_unresolved: 1 })).toEqual({ ownerHasUnresolved: false, memberHasUnresolved: true, blocked: true });
  });
  it('calls a fresh official deletecheck and refuses unresolved or default books before destructive send', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/book/list') ? { list: s.books } : { owner_has_unresolved: 0, member_has_unresolved: 1 } })));
    const result = await s.run((c) => c.submit({ action: 'books.delete', input: { id: '10', expectedVersion: billVersion(s.books[0]!) }, requestId: 'unresolved', scope: s.app.scope })); expect(result.error?.code).toBe('BOOK_UNRESOLVED'); expect(s.upstream.calls.some((call) => call.url.includes('/book/delete?') || call.url.endsWith('/book/delete'))).toBe(false);
    const defaultResult = await s.run((c) => c.submit({ action: 'books.delete', input: { id: '-1', expectedVersion: 'a'.repeat(64) }, requestId: 'default', scope: s.app.scope })); expect(defaultResult.error?.code).toBe('DEFAULT_BOOK_PROTECTED');
  });
  it('uses delete for an owner and quit for a participant, cleaning only the intended local book and its bills', async () => {
    const s = await setup(), removed = await s.run((c) => c.submit({ action: 'books.delete', input: { id: '10', expectedVersion: billVersion(s.books[0]!) }, requestId: 'delete', scope: s.app.scope })); expect(removed.state).toBe('succeeded');
    const deletion = s.upstream.calls.find((call) => call.url.includes('/book/delete') && !call.url.includes('deletecheck'))!; expect(new URLSearchParams(deletion.body).get('bookid')).toBe('10');
    await s.app.repository((r) => { expect(r.readBill(s.app.scope, '1')).toBeNull(); expect(r.readBill(s.app.scope, '2')).not.toBeNull(); });
    const quit = await s.run((c) => c.submit({ action: 'books.quit', input: { id: '20', memberId: s.app.scope.uid, expectedVersion: billVersion(s.books[1]!) }, requestId: 'quit', scope: s.app.scope })); expect(quit.state).toBe('succeeded'); const call = s.upstream.calls.find((call) => call.url.includes('/book/quit'))!; expect(new URLSearchParams(call.body).get('v')).toBe(s.app.scope.uid);
  });
});
describe('book source reuse and explicit hidden selection', () => {
  it('loads all native book types with t=-1, caches once60seconds and preserves hidden books for explicit queries', async () => {
    const s = await setup(); await s.app.repository(async (repository) => { const service = new BookService({ repository, clock: s.clock, client: s.upstream.client, cache: new ResourceCache(repository, s.clock), connection: { scope: () => s.app.scope } });
      const visible = await service.list({ includeHidden: false }); expect(visible.items.map((book) => book.id)).toEqual(['10']); const all = await service.list({ includeHidden: true }); expect(all.items.map((book) => book.id)).toEqual(['10', '20']); expect(all.freshness.complete).toBe(true); expect(s.upstream.calls).toHaveLength(1); expect(new URLSearchParams(s.upstream.calls[0]!.body).get('t')).toBe('-1'); s.clock.advance(60_000); await service.list({ includeHidden: true }); expect(s.upstream.calls).toHaveLength(2);
    });
  });
  it('reads the official type catalog and scoped members, retaining cloud identities and reusing validated sources', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { list: s.upstream.calls.at(-1)!.url.includes('/book/typelist') ? [{ type: 1, name: '日常', cover: 'https://example.test/cover.jpg', desc: '日常收支', range: 'm1' }] : [{ id: s.app.scope.uid, name: '所有者', avatar: '', viptype: 1, vipend: 9999999999 }] } })));
    await s.app.repository(async (repository) => { const service = new BookService({ repository, clock: s.clock, client: s.upstream.client, cache: new ResourceCache(repository, s.clock), connection: { scope: () => s.app.scope } }); const types = await service.types(); expect(types.items).toMatchObject([{ type: 1, name: '日常', range: 'm1' }]); const members = await service.members('10'); expect(members.items).toMatchObject([{ id: s.app.scope.uid, name: '所有者', role: 'owner', vipType: '1' }]); await service.members('10'); expect(s.upstream.calls).toHaveLength(2); expect(new URLSearchParams(s.upstream.calls[1]!.body).get('bookid')).toBe('10'); });
  });
});
describe('book metadata and period changes', () => {
  it('omits a null cover as native JSONObject.put does, accepting the official default cover on creation', async () => {
    const s = await setup(), created = { ...s.books[0]!, bookid: '30', name: '默认封面测试', cover: 'https://example.test/default.jpg' }; s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { v: created } })));
    const result = await s.run((c) => c.submit({ action: 'books.submit', input: { mode: 'create', name: created.name, type: 1, cover: null }, requestId: 'default-cover', scope: s.app.scope })); expect(result.state).toBe('succeeded'); expect(asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)).cover).toBeUndefined();
  });
  it('refuses unverified clearing of an existing cover instead of sending a fabricated null field', async () => {
    const s = await setup(), book = { ...s.books[0]!, cover: 'https://example.test/old.jpg' }; s.books[0] = book;
    const result = await s.run((c) => c.submit({ action: 'books.submit', input: { mode: 'edit', id: '10', expectedVersion: billVersion(book), cover: null }, requestId: 'clear-cover', scope: s.app.scope })); expect(result.error?.code).toBe('BOOK_COVER_CLEAR_UNVERIFIED'); expect(s.upstream.calls.every((call) => !call.url.includes('/book/submit'))).toBe(true);
  });
  it('requires the native config action when clearing an existing custom range instead of silently omitting the intent', async () => {
    const s = await setup(); const result = await s.run((c) => c.submit({ action: 'books.submit', input: { mode: 'edit', id: '10', expectedVersion: billVersion(s.books[0]!), range: '' }, requestId: 'clear-range', scope: s.app.scope })); expect(result.error?.code).toBe('BOOK_RANGE_CLEAR_REQUIRES_CONFIG'); expect(s.upstream.calls.every((call) => !call.url.includes('/book/submit'))).toBe(true);
  });
  it('creates a book using official server ID and native submit fields, without applying unrequested fields', async () => {
    const s = await setup(), created = { ...s.books[0]!, bookid: '30', type: 2, name: '新建测试账本', cover: 'https://example.test/book.png', config: { range: 'm15' }, unknownServerField: 'preserved' };
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { v: created } })));
    const result = await s.run((c) => c.submit({ action: 'books.submit', input: { mode: 'create', name: created.name, type: 2, cover: created.cover, range: 'm15' }, requestId: 'create', scope: s.app.scope })); expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/book/submit'); const v = asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)); expect(Object.keys(v).sort()).toEqual(['cover', 'name', 'range', 'type']); expect(numericText(v.type, '')).toBe('2'); expect(Object.values(result.idMap)).toContain('30');
    await s.app.repository((r) => expect(asBillObject(r.readResources(s.app.scope, 'book', { domain: 'books', ids: ['30'] }).items[0]!.raw).unknownServerField).toBe('preserved'));
  });
  it('edits name and changes range via separate official actions, invalidating the period revision and keeping unknown metadata', async () => {
    const s = await setup(); s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.includes('/book/list')) return new Response(stringifyWire({ ec: 200, data: { list: s.books } })); const v = asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)); s.books[0] = { ...s.books[0]!, ...(v.name === undefined ? {} : { name: String(v.name) }), ...(v.range === undefined ? {} : { config: { range: String(v.range) } }) }; return new Response(stringifyWire({ ec: 200, data: { v: { ...s.books[0]!, extraCloud: 'keep' } } })); });
    const edited = await s.run((c) => c.submit({ action: 'books.submit', input: { mode: 'edit', id: '10', expectedVersion: billVersion(s.books[0]!), name: '修改测试名' }, requestId: 'edit', scope: s.app.scope })); expect(edited.state).toBe('succeeded');
    const before = await s.app.repository((r) => createQueryPlan(r, s.app.scope, { bookIds: ['10'], date: { kind: 'month', year: 2026, month: 1 } }, s.clock));
    const configured = await s.run((c) => c.submit({ action: 'books.configure', input: { id: '10', expectedVersion: billVersion(s.books[0]!), range: 'm15' }, requestId: 'range', scope: s.app.scope })); expect(configured.state).toBe('succeeded');
    const form = new URLSearchParams(s.upstream.calls.find((call) => call.url.includes('/book/config'))!.body); expect(form.get('did')).toBe('10'); expect(form.get('v')).toBe('{"range":"m15"}');
    await s.app.repository((r) => { const after = createQueryPlan(r, s.app.scope, { bookIds: ['10'], date: { kind: 'month', year: 2026, month: 1 } }, s.clock); expect(after.range?.startSec).toBe(Date.parse('2026-01-15T00:00:00+08:00') / 1000); expect(after.revision).not.toBe(before.revision); expect(after.fingerprint).not.toBe(before.fingerprint); expect(asBillObject(r.readResources(s.app.scope, 'book', { domain: 'books', ids: ['10'] }).items[0]!.raw).extraCloud).toBe('keep'); });
  });
  it('reads fresh visibility before toggling, skips an already achieved target, and never resends an unknown toggle', async () => {
    const s = await setup(); const command = { action: 'books.setVisible', input: { id: '10', visible: true }, requestId: 'already', scope: s.app.scope };
    const unchanged = await s.run((c) => c.submit(command)); expect(unchanged.state).toBe('succeeded'); expect(s.upstream.calls.every((call) => !call.url.includes('/book/visible'))).toBe(true);
    s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.includes('/book/visible')) { s.books[0]!.visible = 0; throw new Error('lost response'); } return new Response(stringifyWire({ ec: 200, data: { list: s.books } })); });
    const lost = await s.run((c) => c.submit({ ...command, requestId: 'hide', input: { id: '10', visible: false } })); expect(lost.state).toBe('uncertain'); const reconciled = await s.run((c) => c.reconcileOperation(s.app.scope, lost.id)); expect(reconciled.state).toBe('succeeded'); expect(s.upstream.calls.filter((call) => call.url.includes('/book/visible'))).toHaveLength(1);
  });
  it('sends numeric IDs for native ordering and proves the resulting order with an official read', async () => {
    const s = await setup(); s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.includes('/book/reorder')) { s.books.reverse(); return new Response('{"ec":200}'); } return new Response(stringifyWire({ ec: 200, data: { list: s.books } })); });
    const result = await s.run((c) => c.submit({ action: 'books.reorder', input: { ids: ['20', '10'] }, requestId: 'order', scope: s.app.scope })); const confirmed = result.state === 'succeeded' ? result : await s.run((c) => c.reconcileOperation(s.app.scope, result.id)); expect(confirmed.state).toBe('succeeded'); const v = new URLSearchParams(s.upstream.calls.find((call) => call.url.includes('/book/reorder'))!.body).get('v'); expect(v).toBe('[20,10]');
  });
});
describe('native user base currency configuration', () => {
  it('still sends an explicit base-currency target when an old cached value already equals it', async () => {
    const s = await setup(); await s.app.repository(async (repository) => {
      const config = new AccountingConfiguration({ repository, clock: s.clock }); config.applyOfficial(s.app.scope, { basecur: 'CNY' }); const before = config.read(s.app.scope); s.clock.advance(60_000); s.upstream.respond(async () => new Response('{"ec":200}'));
      const handler = createAccountingConfigurationHandler({ configuration: config }), c = new Coordinator({ repository, clock: s.clock, client: s.upstream.client }, new Map([['books.setBaseCurrency', handler]])); const result = await c.submit({ action: 'books.setBaseCurrency', input: { baseCurrency: 'CNY', expectedVersion: before.editVersion }, requestId: 'explicit-target', scope: s.app.scope }); expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/user/updateconfig');
    });
  });
  it('persists official userconfigs.basecur separately from books, and sends only user/updateconfig v{basecur}', async () => {
    const s = await setup(); await s.app.repository(async (repository) => {
      const config = new AccountingConfiguration({ repository, clock: s.clock }); config.applyOfficial(s.app.scope, { basecur: 'USD', unneededPersonalSetting: true }); const before = config.read(s.app.scope); expect(before.baseCurrency).toBe('USD'); expect(before.freshness.complete).toBe(true);
      s.upstream.respond(async () => new Response('{"ec":200}'));
      const handler = createAccountingConfigurationHandler({ configuration: config }), c = new Coordinator({ repository, clock: s.clock, client: s.upstream.client }, new Map([['books.setBaseCurrency', handler]]));
      const result = await c.submit({ action: 'books.setBaseCurrency', input: { baseCurrency: 'EUR', expectedVersion: before.editVersion }, requestId: 'currency', scope: s.app.scope }); expect(result.state).toBe('succeeded'); expect(config.read(s.app.scope).baseCurrency).toBe('EUR'); expect(config.read(s.app.scope).editVersion).not.toBe(before.editVersion); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/user/updateconfig'); expect(new URLSearchParams(s.upstream.calls[0]!.body).get('v')).toBe('{"basecur":"EUR"}'); expect(asBillObject(repository.readResources(s.app.scope, 'book', { domain: 'books', ids: ['10'] }).items[0]!.raw).basecur).toBeUndefined();
    });
  });
  it('retains the old base currency on unknown write and changes it only after fresh official configuration proof', async () => {
    const s = await setup(); await s.app.repository(async (repository) => {
      const config = new AccountingConfiguration({ repository, clock: s.clock }); config.applyOfficial(s.app.scope, { basecur: 'CNY' }); const before = config.read(s.app.scope);
      s.upstream.respond(async () => { throw new Error('lost response'); });
      const handler = createAccountingConfigurationHandler({ configuration: config, reconcileSource: async () => { s.clock.advance(1); config.applyOfficial(s.app.scope, { basecur: 'USD' }); return true; } }), c = new Coordinator({ repository, clock: s.clock, client: s.upstream.client }, new Map([['books.setBaseCurrency', handler]]));
      const lost = await c.submit({ action: 'books.setBaseCurrency', input: { baseCurrency: 'USD', expectedVersion: before.editVersion }, requestId: 'unknown-currency', scope: s.app.scope }); expect(lost.state).toBe('uncertain'); expect(config.read(s.app.scope).baseCurrency).toBe('CNY'); const recovered = await c.reconcileOperation(s.app.scope, lost.id); expect(recovered.state).toBe('succeeded'); expect(config.read(s.app.scope).baseCurrency).toBe('USD'); expect(s.upstream.calls).toHaveLength(1);
    });
  });
});
