import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { ResourceCache } from '../../src/storage/cache';
import { CategoryService } from '../../src/features/categories/service';
import { createCategoryMutationHandler } from '../../src/features/categories/use-cases';
import { asBillObject, numericText } from '../../src/shared/bill-wire';
import { billVersion,createLedgerMutationHandler } from '../../src/features/ledger/write';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import type { OperationContext } from '../../src/operations/contract';
import { projectBill } from '../../src/features/sync/incremental';
const child = { id: '11', bookid: '1', type: 0, level: 2, parentid: '10', name: '子分类', editable: 1, userid: 'user-A', sort: 0, unknown: 'keep' };
const parent = { ...child, id: '10', level: 1, parentid: -1, name: '父分类', sublist: [child] }, replacement = { ...parent, id: '12', name: '替换分类', sublist: [] };
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope), catalog = [structuredClone(parent), structuredClone(replacement)];
  const own = { id: '1001', bookid: '1', type: 0, time: 1, money: '10', cateid: 11, status: 1, userid: app.scope.uid }, other = { ...own, id: '1002', userid: 'other-member' };
  await app.repository((r) => { r.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); for (const domain of ['books', 'ledger'] as const) { r.createDataset(app.scope, domain, domain); r.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? [projectBill(own), projectBill(other)] : [], deletes: [], resources: domain === 'books' ? [{ id: '1', kind: 'book', raw: { bookid: 1, userid: app.scope.uid, name: 'test', visible: 1 } }] : [], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain); r.switchDataset(app.scope, domain, domain, null); } });
  upstream.respond(async () => { const url = upstream.calls.at(-1)!.url; return new Response(stringifyWire({ ec: 200, data: url.includes('/category/listv2') ? { list: catalog } : url.includes('/category/deletecheckv2') ? { count: 1, other: 1 } : { v: 1 } })); });
  const run = <T>(fn: (c: Coordinator) => Promise<T>, deps: object = {}) => app.repository((repository) => { const handler = createCategoryMutationHandler(deps); return fn(new Coordinator({ repository, clock, client: upstream.client }, new Map(['categories.delete', 'categories.submit', 'categories.changeLevel', 'categories.move', 'categories.reorder'].map((action) => [action, handler])))); });
  const service = <T>(fn: (s: CategoryService) => Promise<T>) => app.repository((repository) => fn(new CategoryService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope } })));
  return { app, clock, upstream, run, service, catalog, own, other, input: { bookId: '1', type: 0, id: '11', expectedVersion: billVersion(child), deleteBills: false, newCategoryId: '12' } };
}
describe('native category parsing and scoped source', () => {
  it('normalizes the numeric native deletion result, preserving0 rather than treating every HTTP200 as deletion', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response('{"ec":200,"data":{"v":0}}')); expect(numericText((await s.upstream.client.request('category.delete', { uid: s.app.scope.uid, did: '11', deletebills: 0 }, s.app.scope)).data, '')).toBe('0');
    s.upstream.respond(async () => new Response('{"ec":200,"data":{"v":"1"}}')); await expect(s.upstream.client.request('category.delete', { uid: s.app.scope.uid, did: '11', deletebills: 0 }, s.app.scope)).rejects.toThrow('QIANJI_RESPONSE_INVALID');
  });
  it('flattens native sublist into shared canonical category records and reuses a60second scope source', async () => {
    const s = await setup(); await s.service(async (service) => { const view = await service.list({ bookId: '1', type: 0 }); expect(view.items.map((item) => [item.id, item.parentId, item.level])).toEqual([['10', null, 1], ['11', '10', 2], ['12', null, 1]]); expect(view.freshness.complete).toBe(true); await service.list({ bookId: '1', type: 0 }); expect(s.upstream.calls).toHaveLength(1); });
    await s.app.repository((r) => expect(asBillObject(r.readResources(s.app.scope, 'category', { domain: 'ledger', ids: ['11'] }).items[0]!.raw).unknown).toBe('keep'));
  });
  it('returns official own/other member reference counts even when local references cannot account for them', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/category/listv2') ? { list: s.catalog } : { count: 7, other: 12 } }))); const check = await s.service((service) => service.checkDelete({ bookId: '1', type: 0, id: '11' })); expect(check).toMatchObject({ count: 7, other: 12, hasChildren: false });
  });
});
describe('category submit hierarchy and sorting', () => {
  it('sends submitv2 v as plain name and saves the official child ID without a second cloud write', async () => {
    const s = await setup(), created = { ...child, id: '21', name: '新建分类', icon: 'test-icon', unknownServerField: 'keep' };
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/category/listv2') ? { list: s.catalog } : { v: created } })));
    const result = await s.run((c) => c.submit({ action: 'categories.submit', input: { bookId: '1', type: 0, mode: 'create', parentId: '10', name: created.name, icon: created.icon }, requestId: 'new-child', scope: s.app.scope })); expect(result.state).toBe('succeeded'); const sends = s.upstream.calls.filter((call) => !call.url.includes('/category/listv2')); expect(sends).toHaveLength(1); const form = new URLSearchParams(sends[0]!.body); expect([form.get('v'), form.get('parentid'), form.get('t'), form.get('bookid'), form.get('did')]).toEqual(['新建分类', '10', '0', '1', null]); expect(Object.values(result.idMap)).toContain('21'); await s.app.repository((r) => expect(asBillObject(r.readResources(s.app.scope, 'category', { domain: 'ledger', ids: ['21'] }).items[0]!.raw).unknownServerField).toBe('keep'));
  });
  it('edits name/icon with original did and parent while preserving the server full object', async () => {
    const s = await setup(), returned = { ...child, name: '修改名称', icon: 'updated-icon', unknown: 'official' }; s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/category/listv2') ? { list: s.catalog } : { v: returned } })));
    const result = await s.run((c) => c.submit({ action: 'categories.submit', input: { bookId: '1', type: 0, mode: 'edit', id: '11', expectedVersion: billVersion(child), name: returned.name, icon: returned.icon }, requestId: 'edit', scope: s.app.scope })); expect(result.state).toBe('succeeded'); const form = new URLSearchParams(s.upstream.calls.at(-1)!.body); expect([form.get('did'), form.get('parentid'), form.get('icon')]).toEqual(['11', '10', 'updated-icon']); await s.app.repository((r) => expect(asBillObject(r.readResources(s.app.scope, 'category', { domain: 'ledger', ids: ['11'] }).items[0]!.raw).unknown).toBe('official'));
  });
  it('uses changelevel with omitted parentid when promoting a child and movesubcate with explicit new parent when moving it', async () => {
    const s = await setup(); s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.includes('/category/listv2')) return new Response(stringifyWire({ ec: 200, data: { list: s.catalog } })); const form = new URLSearchParams(call.body), parentId = form.get('parentid'); return new Response(stringifyWire({ ec: 200, data: { v: { ...child, parentid: parentId ?? -1, level: parentId ? 2 : 1, sublist: [] } } })); });
    const promoted = await s.run((c) => c.submit({ action: 'categories.changeLevel', input: { bookId: '1', type: 0, id: '11', expectedVersion: billVersion(child), parentId: null }, requestId: 'promote', scope: s.app.scope })); expect(promoted.state).toBe('succeeded'); expect(s.upstream.calls.at(-1)!.url).toContain('/category/changelevel'); expect(new URLSearchParams(s.upstream.calls.at(-1)!.body).has('parentid')).toBe(false);
    const moved = await s.run((c) => c.submit({ action: 'categories.move', input: { bookId: '1', type: 0, id: '11', expectedVersion: billVersion(child), parentId: '12' }, requestId: 'move', scope: s.app.scope })); expect(moved.state).toBe('succeeded'); expect(s.upstream.calls.at(-1)!.url).toContain('/category/movesubcate'); expect(new URLSearchParams(s.upstream.calls.at(-1)!.body).get('parentid')).toBe('12');
  });
  it('rejects invalid hierarchy moves and stale source without a mutation request', async () => {
    const s = await setup(); for (const [action, input, code] of [
      ['categories.changeLevel', { id: '10', expectedVersion: billVersion(parent), parentId: '12' }, 'CATEGORY_HAS_CHILDREN'],
      ['categories.move', { id: '12', expectedVersion: billVersion(replacement), parentId: '10' }, 'CATEGORY_MOVE_REQUIRES_CHILD'],
      ['categories.move', { id: '11', expectedVersion: billVersion(child), parentId: '11' }, 'CATEGORY_PARENT_INVALID'],
      ['categories.submit', { mode: 'edit', id: '11', expectedVersion: 'a'.repeat(64), name: 'old' }, 'DRAFT_SOURCE_CHANGED'],
    ] as const) { const result = await s.run((c) => c.submit({ action, input: { bookId: '1', type: 0, ...input }, requestId: crypto.randomUUID(), scope: s.app.scope })); expect(result.error?.code).toBe(code); } expect(s.upstream.calls.every((call) => call.url.includes('/category/listv2'))).toBe(true);
  });
  it('sends the native nested sibling ID arrays and proves official order after an ack', async () => {
    const s = await setup(); s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.includes('/category/reorder3')) { s.catalog.reverse(); return new Response('{"ec":200}'); } return new Response(stringifyWire({ ec: 200, data: { list: s.catalog } })); });
    const result = await s.run((c) => c.submit({ action: 'categories.reorder', input: { bookId: '1', type: 0, groups: [{ parentId: null, ids: ['12', '10'] }, { parentId: '10', ids: ['11'] }] }, requestId: 'order', scope: s.app.scope })); const checked = result.state === 'succeeded' ? result : await s.run((c) => c.reconcileOperation(s.app.scope, result.id)); expect(checked.state).toBe('succeeded'); const v = new URLSearchParams(s.upstream.calls.find((call) => call.url.includes('/category/reorder3'))!.body).get('v')!; expect(v).toBe('[[12,10],[11]]'); expect(Array.isArray(parseWire(v))).toBe(true);
  });
  it('refuses implicit icon clearing and never applies a receipt for a different category ID', async () => {
    const s = await setup(), prior = { ...child, icon: 'old-icon' }; s.catalog[0]!.sublist = [prior];
    const clearing = await s.run((c) => c.submit({ action: 'categories.submit', input: { bookId: '1', type: 0, mode: 'edit', id: '11', expectedVersion: billVersion(prior), icon: '' }, requestId: 'clear-icon', scope: s.app.scope })); expect(clearing.error?.code).toBe('CATEGORY_ICON_CLEAR_UNVERIFIED');
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/category/listv2') ? { list: s.catalog } : { v: { ...prior, id: '999', name: 'mismatch' } } })));
    const wrong = await s.run((c) => c.submit({ action: 'categories.submit', input: { bookId: '1', type: 0, mode: 'edit', id: '11', expectedVersion: billVersion(prior), name: 'mismatch' }, requestId: 'wrong-id', scope: s.app.scope })); expect(wrong.state).toBe('uncertain'); await s.app.repository((r) => expect(r.readResources(s.app.scope, 'category', { domain: 'ledger', ids: ['999'] }).items).toHaveLength(0));
  });
});
describe('category deletion and native migration', () => {
  it('holds edits of actual affected bills while category migration has an unknown result',async()=>{
    const s=await setup();s.upstream.respond(async()=>{const url=s.upstream.calls.at(-1)!.url;if(url.includes('/category/deletev2'))throw new Error('lost receipt');return new Response(stringifyWire({ec:200,data:url.includes('/category/listv2')?{list:s.catalog}:{count:1,other:1}}));});
    await s.app.repository(async repository=>{const c=new Coordinator({repository,clock:s.clock,client:s.upstream.client},new Map([['categories.delete',createCategoryMutationHandler()],['ledger.edit',createLedgerMutationHandler()]]));
      const deleted=await c.submit({action:'categories.delete',input:s.input,requestId:'unknown-category-migration',scope:s.app.scope});expect(deleted.state).toBe('uncertain');
      const edited=await c.submit({action:'ledger.edit',input:{bills:[{id:s.own.id,expectedVersion:billVersion(s.own),changes:{remark:'later edit'}}]},requestId:'edit-during-unknown-migration',scope:s.app.scope});
      expect(edited.state).toBe('queued');expect(edited.error?.code).toBe('TARGET_UNCERTAIN');expect(s.upstream.calls.some(call=>call.url.includes('/bill/syncall'))).toBe(false);
    });
  });

  it('blocks deletion while a queued bill could still upload the old category reference', async () => {
    const s = await setup(); const result = await s.run(async (c) => { c.store.create({ action: 'ledger.create', requestId: 'pending-bill', scope: s.app.scope, input: { bills: [{ categoryId: '11' }] } }, 'pending-category-bill'); return c.submit({ action: 'categories.delete', input: s.input, requestId: 'blocked-delete', scope: s.app.scope }); }); expect(result.error?.code).toBe('UNSYNCED_BILLS'); expect(s.upstream.calls.some((call) => call.url.includes('/category/deletev2'))).toBe(false);
  });
  it('refuses a parent with children before deletecheck/deletion rather than silently cascading', async () => {
    const s = await setup(), result = await s.run((c) => c.submit({ action: 'categories.delete', input: { ...s.input, id: '10', expectedVersion: billVersion(parent), newCategoryId: undefined }, requestId: 'parent', scope: s.app.scope })); expect(result.error?.code).toBe('CATEGORY_HAS_CHILDREN'); expect(s.upstream.calls.some((call) => call.url.includes('/category/delete'))).toBe(false);
  });
  it('uses deletev2/newcateid, retains canonical bills until readonly proof and never uploads per-bill rewrites', async () => {
    const s = await setup(), result = await s.run((c) => c.submit({ action: 'categories.delete', input: s.input, requestId: 'migrate', scope: s.app.scope })); expect(result.state).toBe('partial'); expect(result.items.some((item) => item.state === 'succeeded')).toBe(true); const call = s.upstream.calls.find((call) => call.url.includes('/category/deletev2'))!; const form = new URLSearchParams(call.body); expect([form.get('did'), form.get('newcateid'), form.get('deletebills')]).toEqual(['11', '12', '0']); expect(s.upstream.calls.every((call) => !call.url.includes('/bill/'))).toBe(true);
    await s.app.repository((r) => expect(numericText(asBillObject(r.readBill(s.app.scope, s.own.id)!.raw).cateid, '')).toBe('11'));
    const checked = await s.run((c) => c.reconcileOperation(s.app.scope, result.id), { reconcileSource: async (ctx: OperationContext) => { ctx.repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill({ ...s.own, cateid: 12 })], deletes: [], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true; } }); expect(checked.state).toBe('succeeded');
    await s.app.repository((r) => expect(numericText(asBillObject(r.readBill(s.app.scope, s.other.id)!.raw).cateid, '')).toBe('11'));
  });
  it('keeps a category when native delete result is0 even if this user migration is separately accepted', async () => {
    const s = await setup(); s.upstream.respond(async () => { const url = s.upstream.calls.at(-1)!.url; return new Response(stringifyWire({ ec: 200, data: url.includes('/category/listv2') ? { list: s.catalog } : url.includes('/category/deletecheckv2') ? { count: 1, other: 1 } : { v: 0 } })); }); const result = await s.run((c) => c.submit({ action: 'categories.delete', input: s.input, requestId: 'retained', scope: s.app.scope })); expect(result.state).toBe('uncertain'); expect(result.items.some((item) => item.error?.code === 'CATEGORY_NOT_DELETED')).toBe(true); const checked = await s.run((c) => c.reconcileOperation(s.app.scope, result.id), { reconcileSource: async (ctx: OperationContext) => { ctx.repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill({ ...s.own, cateid: 12 })], deletes: [], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true; } }); expect(checked.state).toBe('partial'); await s.app.repository((r) => expect(r.readResources(s.app.scope, 'category', { domain: 'ledger', ids: ['11'] }).items).toHaveLength(1));
  });
  it('preserves or deletes only this user bills as requested and waits for official read proof for either strategy', async () => {
    for (const deleteBills of [false, true]) {
      const s = await setup(); const result = await s.run((c) => c.submit({ action: 'categories.delete', input: { ...s.input, newCategoryId: undefined, deleteBills }, requestId: 'strategy', scope: s.app.scope })); expect(result.state).toBe('partial'); const form = new URLSearchParams(s.upstream.calls.find((call) => call.url.includes('/category/deletev2'))!.body); expect(form.get('deletebills')).toBe(deleteBills ? '1' : '0'); expect(form.has('newcateid')).toBe(false);
      await s.app.repository((r) => expect(r.readBill(s.app.scope, s.own.id)).not.toBeNull()); const checked = await s.run((c) => c.reconcileOperation(s.app.scope, result.id), { reconcileSource: async (ctx: OperationContext) => { ctx.repository.applyPage(s.app.scope, 'ledger', { upserts: [], deletes: deleteBills ? [s.own.id] : [], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true; } }); expect(checked.state).toBe('succeeded'); await s.app.repository((r) => expect(r.readBill(s.app.scope, s.other.id)).not.toBeNull());
    }
  });
  it('checks a lost delete by complete category and ledger sources, never by resending the mutation', async () => {
    const s = await setup(); s.upstream.respond(async () => { const url = s.upstream.calls.at(-1)!.url; if (url.includes('/category/deletev2')) throw new Error('lost response'); return new Response(stringifyWire({ ec: 200, data: url.includes('/category/listv2') ? { list: s.catalog } : { count: 1, other: 1 } })); });
    const lost = await s.run((c) => c.submit({ action: 'categories.delete', input: s.input, requestId: 'lost-delete', scope: s.app.scope })); expect(lost.state).toBe('uncertain'); s.catalog[0]!.sublist = [];
    const checked = await s.run((c) => c.reconcileOperation(s.app.scope, lost.id), { reconcileSource: async (ctx: OperationContext) => { ctx.repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill({ ...s.own, cateid: 12 })], deletes: [], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true; } }); expect(checked.state).toBe('succeeded'); expect(s.upstream.calls.filter((call) => call.url.includes('/category/deletev2'))).toHaveLength(1);
  });
});
