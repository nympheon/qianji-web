import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { ResourceCache } from '../../src/storage/cache';
import { TagService } from '../../src/features/tags/service';
import { createTagMutationHandler } from '../../src/features/tags/use-cases';
import { billVersion } from '../../src/features/ledger/write';
import { asBillObject } from '../../src/shared/bill-wire';
import { stringifyWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
const tag = { id: 'tag-opaque', name: '午餐', groupid: 'group-opaque', color: '3792FA', status: 1, sort: 0 }, archived = { ...tag, id: 'archived-tag', status: 2 }, group = { id: 'group-opaque', name: '日常', sort: 0, tags: [tag, archived] };
const actions = ['tags.submitTag', 'tags.submitGroup', 'tags.reorderTags', 'tags.reorderGroups', 'tags.setArchived', 'tags.deleteTag', 'tags.deleteGroup'];
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope), catalog = [structuredClone(group)];
  await app.repository((r) => { r.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); r.createDataset(app.scope, 'ledger', 'ledger'); r.applyPage(app.scope, 'ledger', { upserts: [projectBill({ id: '1001', bookid: 1, type: 0, time: 1, money: '10', extra: { tags: [tag.id] } })], deletes: [], resources: [], pageState: null, complete: true, validatedAt: clock.nowIso() }); r.switchDataset(app.scope, 'ledger', 'ledger', null); });
  upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: upstream.calls.at(-1)!.url.includes('/tag/list') ? { list: catalog } : null })));
  const run = <T>(fn: (c: Coordinator) => Promise<T>) => app.repository((repository) => fn(new Coordinator({ repository, clock, client: upstream.client }, new Map(actions.map((action) => [action, createTagMutationHandler()])))));
  const service = <T>(fn: (s: TagService) => Promise<T>) => app.repository((repository) => fn(new TagService({ repository, clock, client: upstream.client, cache: new ResourceCache(repository, clock), connection: { scope: () => app.scope } })));
  return { app, clock, upstream, catalog, run, service };
}
describe('native tag management', () => {
  it('settles a legacy tag-ledger checkpoint from the official absent tag without rewriting historical bills or resending',async()=>{
    const s=await setup(),op=await s.run(c=>c.submit({scope:s.app.scope,action:'tags.deleteTag',input:{id:tag.id,expectedVersion:billVersion(tag)},requestId:'legacy-tag-delete'}));
    s.catalog[0]!.tags=s.catalog[0]!.tags.filter(row=>row.id!==tag.id);
    await s.app.repository(repository=>repository.sql.exec("UPDATE operations SET state='partial',items=? WHERE id=?",JSON.stringify([...op.items,{id:`tag-ledger:${tag.id}`,affectedIds:['1001'],state:'uncertain',error:null}]),op.id).toArray());
    const checked=await s.run(c=>c.reconcileOperation(s.app.scope,op.id));expect(checked.state).toBe('succeeded');expect(s.upstream.calls.filter(call=>call.url.includes('/deletetag'))).toHaveLength(1);
    await s.app.repository(repository=>expect(asBillObject(asBillObject(repository.readBill(s.app.scope,'1001')!.raw).extra).tags).toEqual([tag.id]));
  });
  it('does not confirm a lost group deletion while archived tags still reference that group', async () => {
    const s = await setup(); s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.includes('/deletegroup')) { s.catalog[0]!.id = ''; throw new Error('lost delete'); } return new Response(stringifyWire({ ec: 200, data: { list: s.catalog } })); }); const lost = await s.run((c) => c.submit({ action: 'tags.deleteGroup', input: { id: group.id, expectedVersion: billVersion(group) }, requestId: 'lost-group-delete', scope: s.app.scope })); expect((await s.run((c) => c.reconcileOperation(s.app.scope, lost.id))).state).toBe('uncertain');
  });
  it('confirms native tag deletion while retaining historical bill tag IDs without a fabricated ledger mutation', async () => {
    const s = await setup(), op = await s.run((c) => c.submit({ action: 'tags.deleteTag', input: { id: tag.id, expectedVersion: billVersion(tag) }, requestId: 'delete-tag', scope: s.app.scope })); expect(op.state).toBe('succeeded'); expect(op.items.some((item) => item.id.startsWith('tag-ledger:'))).toBe(false); await s.app.repository((r) => { expect(r.readResources(s.app.scope, 'tag', { domain: 'tags', ids: [tag.id] }).items).toHaveLength(0); expect(asBillObject(asBillObject(r.readBill(s.app.scope, '1001')!.raw).extra).tags).toEqual([tag.id]); }); expect(s.upstream.calls.some((call) => call.url.includes('/bill/'))).toBe(false);
  });
  it('rejects stale versions and invalid colors without any upstream mutation', async () => {
    const s = await setup(); const stale = await s.run((c) => c.submit({ action: 'tags.submitTag', input: { mode: 'edit', id: tag.id, expectedVersion: 'a'.repeat(64), name: '修改', groupId: group.id, color: '3792FA' }, requestId: 'stale', scope: s.app.scope })); expect(stale.error?.code).toBe('DRAFT_SOURCE_CHANGED');
    const invalid = await s.run((c) => c.submit({ action: 'tags.submitTag', input: { mode: 'create', name: '错误颜色', groupId: null, color: '#3792FA' }, requestId: 'invalid-color', scope: s.app.scope })); expect(invalid.state).toBe('failed'); expect(s.upstream.calls.every((v) => v.url.includes('/tag/list'))).toBe(true);
  });
  it('keeps unknown new tags uncertain instead of claiming a same-name match or sending again', async () => {
    const s = await setup(); s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.includes('/submittag')) throw new Error('lost create'); return new Response(stringifyWire({ ec: 200, data: { list: s.catalog } })); });
    const lost = await s.run((c) => c.submit({ action: 'tags.submitTag', input: { mode: 'create', name: tag.name, groupId: group.id, color: tag.color }, requestId: 'lost-create', scope: s.app.scope })); expect(lost.state).toBe('uncertain'); expect((await s.run((c) => c.reconcileOperation(s.app.scope, lost.id))).state).toBe('uncertain'); expect(s.upstream.calls.filter((v) => v.url.includes('/submittag'))).toHaveLength(1);
  });
  it('parses the native data.list wrapper even for the sync-string request constructor', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { list: s.catalog } }))); expect(await s.service((v) => v.list({ includeArchived: true }))).toMatchObject({ items: [{ id: tag.id }, { id: archived.id }], freshness: { complete: true } });
  });
  it('shares a complete grouped source, includes archive only explicitly and reuses validated empty sources', async () => {
    const s = await setup(); expect(await s.service((v) => v.list({ includeArchived: false }))).toMatchObject({ items: [{ id: tag.id }], groups: [{ id: group.id }], freshness: { complete: true, stale: false } }); expect((await s.service((v) => v.list({ includeArchived: true }))).items).toHaveLength(2); expect(s.upstream.calls).toHaveLength(1); s.catalog.length = 0; s.clock.advance(61_000); expect((await s.service((v) => v.list({ includeArchived: true }))).items).toHaveLength(0); await s.service((v) => v.list({})); expect(s.upstream.calls).toHaveLength(2);
  });
  it('reads latest upstream before archive and never reverses an already archived tag from a stale cache', async () => {
    const s = await setup(); await s.service((v) => v.list({})); s.catalog[0]!.tags[0]!.status = 2;
    const op = await s.run((c) => c.submit({ action: 'tags.setArchived', input: { id: tag.id, archived: true }, requestId: 'archive-target', scope: s.app.scope })); expect(op.state).toBe('succeeded'); expect(s.upstream.calls.some((v) => v.url.includes('/archivetag'))).toBe(false); await s.app.repository((r) => expect(asBillObject(r.readResources(s.app.scope, 'tag', { domain: 'tags', ids: [tag.id] }).items[0]!.raw).status).toEqual(expect.objectContaining({ value: '2' })));
  });
  it('replaces archive with the official returned tag and preserves bill tags', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: s.upstream.calls.at(-1)!.url.includes('/tag/list') ? { list: s.catalog } : { v: { ...tag, status: 2, unknown: 'kept' } } })));
    const op = await s.run((c) => c.submit({ action: 'tags.setArchived', input: { id: tag.id, archived: true }, requestId: 'archive', scope: s.app.scope })); expect(op.state).toBe('succeeded'); await s.app.repository((r) => { expect(asBillObject(asBillObject(r.readBill(s.app.scope, '1001')!.raw).extra).tags).toEqual([tag.id]); expect(asBillObject(r.readResources(s.app.scope, 'tag', { domain: 'tags', ids: [tag.id] }).items[0]!.raw).unknown).toBe('kept'); });
  });
  it('deletes only the group and detaches all tags including archives without deleting bills or tags', async () => {
    const s = await setup(), op = await s.run((c) => c.submit({ action: 'tags.deleteGroup', input: { id: group.id, expectedVersion: billVersion(group) }, requestId: 'delete-group', scope: s.app.scope })); expect(op).toMatchObject({ state: 'succeeded', error: null }); await s.app.repository((r) => { expect(r.readResources(s.app.scope, 'tagGroup', { domain: 'tags' }).items).toHaveLength(0); const tags = r.readResources(s.app.scope, 'tag', { domain: 'tags' }).items; expect(tags).toHaveLength(2); expect(tags.every((v) => asBillObject(v.raw).groupid === null)).toBe(true); expect(r.readBill(s.app.scope, '1001')).not.toBeNull(); });
  });
  it('uses opaque string ID arrays and native plain group name versus JSON tag fields', async () => {
    const s = await setup(); s.upstream.respond(async () => { const url = s.upstream.calls.at(-1)!.url; return new Response(stringifyWire({ ec: 200, data: url.includes('/tag/list') ? { list: s.catalog } : { v: url.includes('/submitgroup') ? { ...group, id: 'new-group', name: '新分组', tags: [] } : { ...tag, id: 'new-tag', name: '新标签' } } })); });
    const op = await s.run((c) => c.submit({ action: 'tags.submitTag', input: { mode: 'create', name: '新标签', groupId: group.id, color: '3792FA' }, requestId: 'new-tag', scope: s.app.scope })); expect(op.state).toBe('succeeded'); expect(Object.values(op.idMap)).toContain('new-tag'); const params = new URLSearchParams(s.upstream.calls.find((v) => v.url.includes('/submittag'))!.body); expect(JSON.parse(params.get('v')!)).toEqual({ name: '新标签', groupid: group.id, color: '3792FA' }); expect(params.has('did')).toBe(false);
    await s.run((c) => c.submit({ action: 'tags.submitGroup', input: { mode: 'create', name: '新分组' }, requestId: 'new-group', scope: s.app.scope })); expect(new URLSearchParams(s.upstream.calls.find((v) => v.url.includes('/submitgroup'))!.body).get('v')).toBe('新分组');
    await s.run((c) => c.submit({ action: 'tags.reorderTags', input: { ids: [archived.id, tag.id] }, requestId: 'tag-order', scope: s.app.scope })); expect(new URLSearchParams(s.upstream.calls.find((v) => v.url.includes('/reordertag'))!.body).get('v')).toBe('["archived-tag","tag-opaque"]');
  });
  it('does not resend a lost archive reply and only confirms it after a readonly source proves the target', async () => {
    const s = await setup(); s.upstream.respond(async () => { if (s.upstream.calls.at(-1)!.url.includes('/archivetag')) { s.catalog[0]!.tags[0]!.status = 2; throw new Error('lost'); } return new Response(stringifyWire({ ec: 200, data: { list: s.catalog } })); });
    const lost = await s.run((c) => c.submit({ action: 'tags.setArchived', input: { id: tag.id, archived: true }, requestId: 'lost-archive', scope: s.app.scope })); const checked = lost.state === 'succeeded' ? lost : await s.run((c) => c.reconcileOperation(s.app.scope, lost.id)); expect(checked.state).toBe('succeeded'); expect(s.upstream.calls.filter((v) => v.url.includes('/archivetag'))).toHaveLength(1);
  });
});
