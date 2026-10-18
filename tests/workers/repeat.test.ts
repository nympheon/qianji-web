import { expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { createRepeatMutationHandler } from '../../src/features/repeat/use-cases';
import { RepeatService } from '../../src/features/repeat/service';
import { ResourceCache } from '../../src/storage/cache';
import { repeatView } from '../../src/features/repeat/source';
import { asBillObject } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
const task = () => ({ id: '100', packid: '900', userid: 'user-A', type: 0, count: 3, status: 0, createtime: 100, updatetime: 200, unknown: true, data: { bookid: '1', cateid: '2', fromid: '-1', targetid: '-1', money: '10', fee: '0', start: '2026-01-01', time: '08:30', repeat: { type: 'day', value: [] }, remark: 'test', billflag: 0, images: [], tags: [], unknownData: 'keep' } });
async function setup() {
  const app = await createTestApp(), clock = new TestClock(), upstream = createUpstream(clock, app.scope); let current = task(), binding = '999', mutations = 0, lost = false, present = true, ledgerReady = true;
  await app.repository((repository) => { repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray(); for (const domain of ['ledger', 'books'] as const) { repository.createDataset(app.scope, domain, domain); repository.applyPage(app.scope, domain, { upserts: domain === 'ledger' ? [projectBill({ id: '500', userid: app.scope.uid, bookid: '1', type: 0, time: 100, money: '10', packid: binding, extra: {} })] : [], deletes: [], resources: domain === 'books' ? [{ id: '1', kind: 'book', raw: { bookid: '1' } }] : [{ id: '2', kind: 'category', raw: { id: '2', bookid: '1', type: 0 } }], complete: true, validatedAt: clock.nowIso(), pageState: null }, domain); repository.switchDataset(app.scope, domain, domain, null); } });
  upstream.respond(async () => {
    const call = upstream.calls.at(-1)!, action = new URL(call.url).pathname.split('/').at(-1), params = new URLSearchParams(call.body);
    if (action === 'list') return Response.json({ ec: 200, data: { list: present ? [current] : [], hasmore: false } });
    mutations++;
    if (action === 'toggle') { current = { ...current, status: current.status === 0 ? 1 : 0 }; if (lost) throw new Error('lost response'); return Response.json({ ec: 200, data: { list: [] } }); }
    if (action === 'submit') { current = asBillObject(parseWire(params.get('v')!)) as unknown as ReturnType<typeof task>; return new Response(stringifyWire({ ec: 200, data: { task: current, bills: [] } })); }
    if (action === 'bindbill') { binding = binding === '900' ? '-1' : '900'; return Response.json({ ec: 200 }); }
    return Response.json({ ec: 200 });
  });
  const run = <T>(fn: (value: { coordinator: Coordinator; service: RepeatService }) => Promise<T>) => app.repository((repository) => { const ctx = { repository, clock, client: upstream.client }, refreshLedger = async () => { if (!ledgerReady) return false; const dataset = repository.dataset(app.scope, 'ledger')!; repository.applyPage(app.scope, dataset.id, { upserts: [projectBill({ id: '500', userid: app.scope.uid, bookid: '1', type: 0, time: 100, money: '10', packid: binding, extra: {} })], deletes: [], resources: [], pageState: null, complete: true, validatedAt: clock.nowIso() }); return true; }, handler = createRepeatMutationHandler({ refreshLedger }), coordinator = new Coordinator(ctx, new Map(['repeat.submit', 'repeat.setPaused', 'repeat.setBillBinding', 'repeat.delete'].map((action) => [action, handler]))), service = new RepeatService({ ...ctx, connection: { scope: () => app.scope }, cache: new ResourceCache(repository, clock), coordinator }); return fn({ coordinator, service }); });
  return { app, upstream, clock, run, current: () => current, mutations: () => mutations, lose: () => { lost = true; }, remove: () => { present = false; }, setLedgerReady: (ready: boolean) => { ledgerReady = ready; } };
}
it('does not flip a phone-paused task when pause is already the requested goal', async () => {
  const s = await setup(), result = await s.run(({ coordinator }) => coordinator.submit({ action: 'repeat.setPaused', requestId: 'pause-goal', scope: s.app.scope, input: { id: '100', paused: true } })); expect(result.state).toBe('succeeded'); expect(s.mutations()).toBe(0);
});
it('retains freshly validated caches after a no-op pause goal', async () => {
  const s = await setup(); await s.run(async ({ coordinator, service }) => { await coordinator.submit({ action: 'repeat.setPaused', requestId: 'noop-caches', scope: s.app.scope, input: { id: '100', paused: true } }); await service.list({}); expect(s.upstream.calls).toHaveLength(1); });
});
it('does not call targetT.bindbill when unbindingT and the bill is already bound toU', async () => {
  const s = await setup(), result = await s.run(({ coordinator }) => coordinator.submit({ action: 'repeat.setBillBinding', requestId: 'unbind-other', scope: s.app.scope, input: { planId: '100', packId: '900', billId: '500', bound: false } })); expect(result.state).toBe('succeeded'); expect(s.mutations()).toBe(0);
});
it('recovers an unknown toggle by fresh readonly goal proof without a second toggle', async () => {
  const s = await setup(); s.lose(); await s.run(async ({ coordinator }) => { const result = await coordinator.submit({ action: 'repeat.setPaused', requestId: 'resume-lost', scope: s.app.scope, input: { id: '100', paused: false } }); expect(result.state).toBe('uncertain'); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(s.mutations()).toBe(1); });
});
it('preserves native unknown task fields and history when editing only future rule data', async () => {
  const s = await setup(); await s.run(async ({ coordinator }) => { const result = await coordinator.submit({ action: 'repeat.submit', requestId: 'edit-future', scope: s.app.scope, input: { mode: 'edit', id: '100', expectedVersion: repeatView(task()).editVersion, changes: { remark: 'updated' } } }); expect(result.state).toBe('succeeded'); const saved = s.current(); expect(saved).toMatchObject({ unknown: true, data: { unknownData: 'keep', remark: 'updated' } }); expect(repeatView(saved).count).toBe(3); }); expect(s.upstream.calls.some((call) => call.url.includes('/bill/syncall'))).toBe(false);
});
it('caches empty complete task lists for60s from source validation rather than reads', async () => {
  const s = await setup(); s.upstream.respond(async () => Response.json({ ec: 200, data: { list: [], hasmore: false } })); await s.run(async ({ service }) => { expect((await service.list({})).items).toEqual([]); s.clock.advance(59000); await service.list({}); expect(s.upstream.calls).toHaveLength(1); s.clock.advance(1001); await service.list({}); expect(s.upstream.calls).toHaveLength(2); });
});

it('does not finish an unknown toggle until its possible generated bills have been synchronized', async () => {
  const s = await setup(); s.lose(); s.setLedgerReady(false); await s.run(async ({ coordinator }) => { const result = await coordinator.submit({ action: 'repeat.setPaused', requestId: 'lost-with-bills', scope: s.app.scope, input: { id: '100', paused: false } }); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('uncertain'); s.setLedgerReady(true); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(s.mutations()).toBe(1); });
});
it('removes absent tasks only after a complete official list and retains existing historical bills', async () => {
  const s = await setup(); await s.run(async ({ service }) => { await service.list({}); s.remove(); s.clock.advance(60001); expect((await service.list({})).items).toEqual([]); }); await s.app.repository((repository) => { expect(repository.readResources(s.app.scope, 'repeat', { domain: 'repeat', ids: ['100'] }).items).toEqual([]); expect(repository.readBill(s.app.scope, '500')).not.toBeNull(); });
});
it('preserves a prior saved base currency when only the task remark changes', async () => {
  const s = await setup(), native = task(), curr = { ss: 'USD', sv: '10', ts: 'CNY', tv: '70', bs: 'EUR', bv: '8' }; const raw = { ...native, data: { ...native.data, curr } }; let posted: unknown;
  s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.includes('/list')) return new Response(stringifyWire({ ec: 200, data: { list: [raw], hasmore: false } })); const body = asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)); posted = body; return new Response(stringifyWire({ ec: 200, data: { task: body, bills: [] } })); });
  const result = await s.run(({ coordinator }) => coordinator.submit({ action: 'repeat.submit', scope: s.app.scope, requestId: 'metadata-old-base', input: { mode: 'edit', id: '100', expectedVersion: repeatView(raw).editVersion, changes: { ...repeatView(raw).fields!, remark: 'updated' } } })); expect(result.state).toBe('succeeded'); expect(posted).toMatchObject({ data: { curr: { bs: 'EUR' }, remark: 'updated' } });
});
it('applies only official task and bill receipts and leaves previous bill history intact', async () => {
  const s = await setup(); s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.includes('/list')) return Response.json({ ec: 200, data: { list: [task()], hasmore: false } }); const raw = asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)); return new Response(stringifyWire({ ec: 200, data: { task: { ...raw, id: '101', packid: '901', userid: s.app.scope.uid, status: 1 }, bills: [{ id: '600', userid: s.app.scope.uid, bookid: '1', packid: '901', type: 0, time: 200, money: '10', extra: {} }] } })); });
  const result = await s.run(({ coordinator }) => coordinator.submit({ action: 'repeat.submit', scope: s.app.scope, requestId: 'official-task-bills', input: { mode: 'create', fields: repeatView(task()).fields! } })); expect(result.state).toBe('succeeded'); expect(Object.values(result.idMap)).toEqual(['101']); await s.app.repository((repository) => { expect(repository.readBill(s.app.scope, '600')?.bookId).toBe('1'); expect(repository.readBill(s.app.scope, '500')).not.toBeNull(); }); expect(s.upstream.calls.filter((call) => call.url.includes('/submit'))).toHaveLength(1); expect(s.upstream.calls.some((call) => call.url.includes('/bill/syncall'))).toBe(false);
});
it('rejects a mismatched official generated-bill group before publishing either task or bills', async () => {
  const s = await setup(); s.upstream.respond(async () => { const call = s.upstream.calls.at(-1)!; if (call.url.includes('/list')) return Response.json({ ec: 200, data: { list: [task()], hasmore: false } }); const raw = asBillObject(parseWire(new URLSearchParams(call.body).get('v')!)); return new Response(stringifyWire({ ec: 200, data: { task: { ...raw, id: '101', packid: '901', userid: s.app.scope.uid }, bills: [{ id: '600', userid: s.app.scope.uid, bookid: '1', packid: '999', type: 0, time: 200, money: '10', extra: {} }] } })); });
  const result = await s.run(({ coordinator }) => coordinator.submit({ action: 'repeat.submit', scope: s.app.scope, requestId: 'wrong-bill-group', input: { mode: 'create', fields: repeatView(task()).fields! } })); expect(result.state).toBe('uncertain'); await s.app.repository((repository) => { expect(repository.readBill(s.app.scope, '600')).toBeNull(); expect(repository.readResources(s.app.scope, 'repeat', { domain: 'repeat', ids: ['101'] }).items).toHaveLength(0); });
});
it('refuses to toggle a finished task and proves an accepted bill binding without resending it', async () => {
  const s = await setup(); s.upstream.respond(async () => Response.json({ ec: 200, data: { list: [{ ...task(), status: -1 }], hasmore: false } })); const finished = await s.run(({ coordinator }) => coordinator.submit({ action: 'repeat.setPaused', scope: s.app.scope, requestId: 'finished-toggle', input: { id: '100', paused: false } })); expect(finished.state).toBe('failed'); expect(s.upstream.calls.every((call) => call.url.includes('/list'))).toBe(true);
  const binding = await setup(); await binding.run(async ({ coordinator }) => { const command = { action: 'repeat.setBillBinding', scope: binding.app.scope, requestId: 'bind-existing', input: { planId: '100', packId: '900', billId: '500', bound: true } }, result = await coordinator.submit(command); expect(result.state).toBe('uncertain'); expect((await coordinator.reconcileOperation(binding.app.scope, result.id)).state).toBe('succeeded'); expect((await coordinator.submit(command)).state).toBe('succeeded'); expect(binding.mutations()).toBe(1); });
});
it('fetches only the holiday year needed by the preview and does not require an unpublished next year', async () => {
  const s = await setup(); s.upstream.respond(async () => { const years = new URLSearchParams(s.upstream.calls.at(-1)!.body).get('years'); return years === '2026' ? Response.json({ ec: 200, data: { years: { '2026': { '2026-01-01': { holiday: true } } } } }) : Response.json({ ec: 500 }); });
  await s.run(async ({ service }) => { const input = { fields: { ...repeatView(task()).fields!, repeat: { type: 'workday' as const, values: [] } }, limit: 3 }; expect(await service.preview(input)).toHaveLength(3); await service.preview(input); expect(s.upstream.calls).toHaveLength(1); expect(new URLSearchParams(s.upstream.calls[0]!.body).get('years')).toBe('2026'); });
});
