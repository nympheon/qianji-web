import { describe, expect, it } from 'vitest';
import { summarizeAssets } from '../../src/features/assets/summary';
import { createAssetMutationHandler } from '../../src/features/assets/use-cases';
import { createTestApp } from '../support/app';
import { createUpstream, TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { billVersion } from '../../src/features/ledger/write';
import { asBillObject, numericText } from '../../src/shared/bill-wire';
import { parseWire, stringifyWire } from '../../src/shared/wire-json';
import { projectBill } from '../../src/features/sync/incremental';
import { AssetService } from '../../src/features/assets/service';
import { ResourceCache } from '../../src/storage/cache';
import { createAssetGroupMutationHandler } from '../../src/features/assets/groups';

const asset = (id = '10', money = '100', type = 1, stype = 11) => asBillObject(parseWire(`{"id":${id},"userid":"user-A","name":"test-asset","money":${money},"type":${type},"stype":${stype},"currency":"CNY","status":0,"incount":1,"extra":{"preserve":true}}`));
async function setup() {
  const app = await createTestApp(), clock = new TestClock(Date.now() + 3600_000), upstream = createUpstream(clock, app.scope), original = asset();
  await app.repository((repo) => {
    repo.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();
    for (const domain of ['ledger', 'assets'] as const) { repo.createDataset(app.scope, domain, domain); repo.applyPage(app.scope, domain, { upserts: [], deletes: [], resources: domain === 'assets' ? [{ id: '10', kind: 'asset', raw: original }] : [], pageState: null, complete: true, validatedAt: clock.nowIso() }, domain); repo.switchDataset(app.scope, domain, domain, null); }
  });
  upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: asset('10', '120') } })));
  const command = (input = {}, action = 'assets.adjustBalance', requestId = crypto.randomUUID()) => ({ action, requestId, scope: app.scope, input: { id: '10', expectedVersion: billVersion(original), money: '120', recordDifference: false, ...input } });
  const run = <T>(fn: (coordinator: Coordinator) => Promise<T>) => app.repository((repository) => fn(new Coordinator({ repository, client: upstream.client, clock }, new Map(['assets.submit', 'assets.adjustBalance', 'assets.setFinished', 'assets.setVisible', 'assets.reorder', 'assets.delete'].map((action) => [action, createAssetMutationHandler()])))));
  return { app, clock, upstream, original, command, run };
}
describe('native assets and balance changes', () => {
  it('refreshes visible asset membership on use, coalesces concurrent reads and keeps official canonical replacements', async () => {
    const s = await setup(); let balance = '100';
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { list: [asset('10', balance)], groups: [{ groupid: 'official-group', name: '测试分组', sort: 0 }] } })));
    await s.app.repository(async (repository) => {
      const cache = new ResourceCache(repository, s.clock), service = new AssetService({ repository, cache, client: s.upstream.client, clock: s.clock, connection: { scope: () => s.app.scope } });
      const first = await Promise.all([service.list(), service.list()]); expect(first[0]).toMatchObject({ items: [{ id: '10', money: '100' }], groups: [{ id: 'official-group', name: '测试分组' }], freshness: { complete: true, stale: false } }); expect(s.upstream.calls).toHaveLength(1);
      expect(await service.summary({})).toMatchObject({ summary: { currencies: [{ currency: 'CNY', net: '100' }] } }); expect(s.upstream.calls).toHaveLength(1);
      balance = '120'; await service.list(); expect(s.upstream.calls).toHaveLength(1); s.clock.advance(60_000); expect(await service.list()).toMatchObject({ items: [{ money: '120' }] }); expect(s.upstream.calls).toHaveLength(2);
      cache.confirmResources(s.app.scope, 'assets', [{ id: '10', kind: 'asset', raw: asset('10', '130') }]); expect(await service.list()).toMatchObject({ items: [{ money: '130' }] }); expect(s.upstream.calls).toHaveLength(2);
      s.clock.advance(60_000); s.upstream.respond(async () => { throw new Error('offline'); }); expect(await service.list()).toMatchObject({ items: [{ money: '130' }], freshness: { stale: true }, problem: { code: 'QIANJI_NETWORK_ERROR' } });
    });
  });
  it('reads official type groups and returns an empty real history without generating interpolated points', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { list: s.upstream.calls.at(-1)!.url.includes('/asset/typelist') ? [{ name: '现金及存款' }, { type: { type: 1, stype: 11, name: '现金', icon: 'native-cash', c: '#e5aa22' } }] : [] } })));
    await s.app.repository(async (repository) => {
      const service = new AssetService({ repository, cache: new ResourceCache(repository, s.clock), client: s.upstream.client, clock: s.clock, connection: { scope: () => s.app.scope } });
      expect(await service.types()).toMatchObject({ items: [{ type: 1, subtype: 11, name: '现金', group: '现金及存款' }], freshness: { complete: true } });
      expect(await service.trend({ id: '10', fromSec: 100, toSec: 200 })).toMatchObject({ points: [], currency: 'CNY', freshness: { complete: true } });
      const form = new URLSearchParams(s.upstream.calls.at(-1)!.body); expect(form.get('did')).toBe('10'); expect(parseWire(form.get('flts')!)).toEqual({ date: '100,200' });
    });
  });
  it('excludes wrappers, respects incount, clamps debt direction and subtracts only active counted installments', () => {
    const a = asset(), wrapper = { ...asset('11', '1000', 6), stype: 61 }, debt = asset('12', '-20', 5, 51), overDebt = asset('13', '5', 5, 51), loan = asset('14', '30', 5, 52), overLoan = asset('15', '-5', 5, 52), excluded = { ...asset('16', '999'), incount: 0 };
    const credit = { ...asset('17', '-10', 2, 21), installs: [{ money: 40, fee: 2, incount: 1, status: 1, data: { feeincount: 1 } }, { money: 99, fee: 0, incount: 1, status: -1 }, { money: 999, fee: 0, incount: 0, status: 1 }] };
    expect(summarizeAssets([a, wrapper, debt, overDebt, loan, overLoan, excluded, credit], true)).toMatchObject({ currencies: [{ currency: 'CNY', assets: '130', liabilities: '-52', borrowed: '-20', lent: '30', net: '58', installments: '42' }] });
    expect(summarizeAssets([a, wrapper, debt, overDebt, loan, overLoan, excluded, credit], false)).toMatchObject({ currencies: [{ currency: 'CNY', liabilities: '-10', net: '100' }] });
  });
  it('changes balance through asset.submit, omits diffparams when not requested and never invents an adjustment bill', async () => {
    const s = await setup(), command = s.command(); const result = await s.run((coordinator) => coordinator.submit(command)); expect(result.state).toBe('succeeded');
    expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/asset/submit'); const form = new URLSearchParams(s.upstream.calls[0]!.body); expect(form.has('diffparams')).toBe(false); expect(numericText(asBillObject(parseWire(form.get('v')!)).money, '')).toBe('120');
    await s.app.repository((repo) => { expect(repo.sql.exec('SELECT id FROM bills').toArray()).toHaveLength(0); expect(numericText(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money, '')).toBe('120'); });
  });
  it('blocks a balance change when a different book has an unsynced normal bill', async () => {
    const s = await setup(); await s.app.repository((repo) => repo.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(parseWire('{"id":99,"bookid":999,"type":0,"money":1,"time":100,"status":2}'))], deletes: [], resources: [], pageState: null }));
    expect((await s.run((coordinator) => coordinator.submit(s.command()))).error?.code).toBe('UNSYNCED_BILLS'); expect(s.upstream.calls).toHaveLength(0);
  });
  it('also blocks balance changes for account-wide queued ledger intents that have not reached the mirror', async () => {
    const s = await setup(); await s.run(async (coordinator) => { const command = { action: 'ledger.create', requestId: 'other-book-intent', scope: s.app.scope, input: { bills: [{ bookId: '999', assetId: '20', enteredMoney: '1' }] } }; coordinator.store.create(command, 'fixture-pending-ledger-digest'); expect((await coordinator.submit(s.command())).error?.code).toBe('UNSYNCED_BILLS'); }); expect(s.upstream.calls).toHaveLength(0);
  });
  it('includes newly introduced debt bill intents in the account-wide unsynced balance guard', async () => {
    const s = await setup(); await s.run(async (coordinator) => { coordinator.store.create({ action: 'debt.pay', requestId: 'debt-queued', scope: s.app.scope, input: { id: '100', principal: '1' } }, 'pending-debt-digest'); expect((await coordinator.submit(s.command())).error?.code).toBe('UNSYNCED_BILLS'); }); expect(s.upstream.calls).toHaveLength(0);
  });
  it('converts the entered credit balance back to stored money with counted outstanding installments once', async () => {
    const s = await setup(), original = { ...asset('10', '100', 2, 21), installs: [{ money: 40, fee: 2, incount: 1, status: 1, data: { feeincount: 1 } }] };
    await s.app.repository((repo) => repo.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '10', kind: 'asset', raw: original }], pageState: null }, 'assets'));
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: { ...original, money: 142 } } })));
    const result = await s.run((coordinator) => coordinator.submit(s.command({ expectedVersion: billVersion(original), money: '100' }))); expect(result.state).toBe('succeeded'); expect(numericText(asBillObject(parseWire(new URLSearchParams(s.upstream.calls[0]!.body).get('v')!)).money, '')).toBe('142');
  });
  it('sends native diffparams and saves only an actual official bound bill together with the asset', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: asset('10', '120'), bill: parseWire('{"id":9007199254740999,"bookid":1,"type":1,"money":20,"time":100,"assetid":10,"userid":"user-A","cateid":2,"remark":"difference","extra":{"flag":1}}') } })));
    const result = await s.run((coordinator) => coordinator.submit(s.command({ recordDifference: true, difference: { categoryId: '2', countInStatistics: false, countInBudget: true, remark: 'difference' } }))); expect(result.state).toBe('succeeded');
    const form = new URLSearchParams(s.upstream.calls[0]!.body), diff = asBillObject(parseWire(form.get('diffparams')!)); expect(numericText(diff.cateid, '')).toBe('2'); expect(numericText(diff.billflag, '')).toBe('1'); expect(diff.remark).toBe('difference');
    await s.app.repository((repo) => expect(repo.readBill(s.app.scope, '9007199254740999')?.money).toBe('20'));
  });
  it('rejects a mismatched official difference amount without applying either resource', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: asset('10', '120'), bill: parseWire('{"id":9007199254740999,"bookid":1,"type":1,"money":999,"time":100,"assetid":10,"userid":"user-A","cateid":2}') } })));
    const result = await s.run((coordinator) => coordinator.submit(s.command({ recordDifference: true, difference: { categoryId: '2', countInStatistics: true, countInBudget: true } }))); expect(result.state).toBe('uncertain');
    await s.app.repository((repo) => { expect(repo.readBill(s.app.scope, '9007199254740999')).toBeNull(); expect(numericText(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money, '')).toBe('100'); });
  });
  it('freshly reads a finish target, skips a toggle already at target and never zeros the debt', async () => {
    const s = await setup(); const debt = asset('10', '-100', 5, 51); await s.app.repository((repo) => repo.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '10', kind: 'asset', raw: debt }], pageState: null }, 'assets'));
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { ...debt, status: 1 } })));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'assets.setFinished', requestId: 'finish-target', scope: s.app.scope, input: { id: '10', finished: true } })); expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/asset/info');
    await s.app.repository((repo) => expect(numericText(asBillObject(repo.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).money, '')).toBe('-100'));
  });
  it('never toggles finish again after a lost response; reconciliation only reads the actual target', async () => {
    const s = await setup(), debt = asset('10', '-100', 5, 51); let finished = false, mutations = 0;
    s.upstream.respond(async () => {
      const call = s.upstream.calls.at(-1)!;
      if (call.url.includes('/asset/info')) return new Response(stringifyWire({ ec: 200, data: { ...debt, status: finished ? 1 : 0 } }));
      mutations++; finished = true; throw new Error('lost finish response');
    });
    const command = { action: 'assets.setFinished', requestId: 'unknown-finish', scope: s.app.scope, input: { id: '10', finished: true } };
    await s.run(async (coordinator) => { const result = await coordinator.submit(command); expect(result.state).toBe('uncertain'); expect((await coordinator.submit(command)).id).toBe(result.id); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); }); expect(mutations).toBe(1); expect(s.upstream.calls.filter((call) => call.url.includes('/asset/info'))).toHaveLength(2);
  });
  it('creates a typed ordinary asset using the authoritative server ID and preserves extra on later metadata edits', async () => {
    const s = await setup(), created = { ...asset('9007199254740999', '50'), name: '测试专用现金' };
    s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: created } })));
    await s.run(async (coordinator) => {
      const command = { action: 'assets.submit', requestId: 'new-test-asset', scope: s.app.scope, input: { mode: 'create', fields: { type: 1, subtype: 11, name: '测试专用现金', money: '50', currency: 'CNY', inCount: true } } };
      const result = await coordinator.submit(command); expect(result.state).toBe('succeeded'); expect(Object.values(result.idMap)).toContain('9007199254740999'); expect((await coordinator.submit(command)).id).toBe(result.id); expect(s.upstream.calls).toHaveLength(1);
      s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { asset: { ...created, remark: '仅修改备注' } } })));
      expect((await coordinator.submit({ action: 'assets.submit', requestId: 'metadata-edit', scope: s.app.scope, input: { mode: 'edit', id: '9007199254740999', expectedVersion: billVersion(created), changes: { remark: '仅修改备注' } } })).state).toBe('succeeded');
      const sent = asBillObject(parseWire(new URLSearchParams(s.upstream.calls[1]!.body).get('v')!)); expect(asBillObject(sent.extra).preserve).toBe(true); expect(numericText(sent.money, '')).toBe('50');
    });
  });
  it('does not reverse a visibility target that another client already achieved', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { ...s.original, status: 2 } })));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'assets.setVisible', requestId: 'hide', scope: s.app.scope, input: { id: '10', visible: false } })); expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/asset/info');
  });
  it('blocks ordinary asset deletion with active installment dependencies before any delete request', async () => {
    const s = await setup(); s.upstream.respond(async () => new Response('{"ec":200,"data":{"installcount":1,"repeatcount":0}}'));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'assets.delete', requestId: 'delete-check', scope: s.app.scope, input: { id: '10', expectedVersion: billVersion(s.original) } })); expect(result.error?.code).toBe('ASSET_IN_USE'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/asset/deletecheck');
  });
  it('uses the native debt deletion path without an ordinary asset dependency check', async () => {
    const s = await setup(), debt = asset('10', '-50', 5, 51); await s.app.repository((repo) => repo.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: '10', kind: 'asset', raw: debt }], pageState: null }, 'assets'));
    s.upstream.respond(async () => new Response('{"ec":200,"data":{"list":[]}}'));
    const result = await s.run((coordinator) => coordinator.submit({ action: 'assets.delete', requestId: 'debt-delete', scope: s.app.scope, input: { id: '10', expectedVersion: billVersion(debt) } })); expect(result.state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(1); expect(s.upstream.calls[0]!.url).toContain('/asset/delete'); expect(s.upstream.calls[0]!.url).not.toContain('deletecheck');
  });
  it('uses official opaque group IDs and removes only the requested group membership after a fresh read', async () => {
    const s = await setup();
    await s.app.repository(async (repository) => {
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map(['assets.groups.submit', 'assets.groups.remove'].map((action) => [action, createAssetGroupMutationHandler()])));
      s.upstream.respond(async () => new Response('{"ec":200,"data":{"groupid":"group-UUID","name":"测试分组","sort":0,"userid":"user-A"}}'));
      const result = await coordinator.submit({ action: 'assets.groups.submit', requestId: 'group-create', scope: s.app.scope, input: { id: null, name: '测试分组' } }); expect(result.state).toBe('succeeded'); expect(Object.values(result.idMap)).toContain('group-UUID'); expect(new URLSearchParams(s.upstream.calls[0]!.body).has('groupid')).toBe(false);
      s.upstream.respond(async () => new Response(stringifyWire({ ec: 200, data: { ...s.original, groupid: 'another-group' } })));
      expect((await coordinator.submit({ action: 'assets.groups.remove', requestId: 'remove-old-group', scope: s.app.scope, input: { groupId: 'group-UUID', assetId: '10' } })).state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(2); expect(s.upstream.calls[1]!.url).toContain('/asset/info');
      expect(asBillObject(repository.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items[0]!.raw).groupid).toBe('another-group');
    });
  });
  it('sends native numeric group asset IDs and startSort, then verifies membership through reads only', async () => {
    const s = await setup();
    await s.app.repository(async (repository) => {
      repository.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: 'group-UUID', kind: 'assetGroup', raw: { groupid: 'group-UUID', name: '测试分组' } }, { id: '20', kind: 'asset', raw: { ...asset('20'), groupid: 'group-UUID' } }, { id: '30', kind: 'asset', raw: { ...asset('30'), groupid: 'group-UUID', status: 2 } }], pageState: null }, 'assets');
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['assets.groups.add', createAssetGroupMutationHandler()]]));
      s.upstream.respond(async () => s.upstream.calls.at(-1)!.url.includes('/asset/info') ? new Response(stringifyWire({ ec: 200, data: { ...s.original, groupid: 'group-UUID' } })) : new Response('{"ec":200}'));
      const result = await coordinator.submit({ action: 'assets.groups.add', requestId: 'group-add', scope: s.app.scope, input: { groupId: 'group-UUID', assetIds: ['10'] } }); expect(result.state).toBe('uncertain');
      const form = new URLSearchParams(s.upstream.calls[0]!.body); expect(form.get('assetids')).toBe('[10]'); expect(form.get('startSort')).toBe('2'); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(s.upstream.calls.filter((call) => call.url.includes('/asset_group/addasset'))).toHaveLength(1);
    });
  });
  it('keeps native asset deletion and ledger impact confirmation separate without issuing extra bill deletions', async () => {
    const s = await setup(), ordinary = parseWire('{"id":91,"bookid":1,"type":0,"money":5,"time":100,"assetid":10,"userid":"user-A"}'), transfer = parseWire('{"id":92,"bookid":1,"type":2,"money":5,"time":100,"fromid":10,"targetid":20,"userid":"user-A"}');
    await s.app.repository(async (repository) => {
      repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill(ordinary), projectBill(transfer)], deletes: [], resources: [], pageState: null });
      s.upstream.respond(async () => new Response(s.upstream.calls.at(-1)!.url.includes('/asset/deletecheck') ? '{"ec":200,"data":{"installcount":0,"repeatcount":0}}' : '{"ec":200,"data":{"list":[]}}'));
      const handler = createAssetMutationHandler({ reconcileLedger: async () => { s.clock.advance(1); repository.applyPage(s.app.scope, 'ledger', { upserts: [projectBill({ ...asBillObject(ordinary), assetid: -1 })], deletes: ['92'], resources: [], pageState: null, complete: true, validatedAt: s.clock.nowIso() }); return true; } });
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['assets.delete', handler]]));
      const result = await coordinator.submit({ action: 'assets.delete', requestId: 'asset-delete-related', scope: s.app.scope, input: { id: '10', expectedVersion: billVersion(s.original) } }); expect(result.state).toBe('partial'); expect(repository.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items).toHaveLength(0); expect(repository.readBill(s.app.scope, '92')).not.toBeNull();
      expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded'); expect(s.upstream.calls).toHaveLength(2); expect(s.upstream.calls.every((call) => call.url.includes('/asset/'))).toBe(true);
    });
  });
  it('deletes only the official group and removes stale canonical group metadata after a complete list proof', async () => {
    const s = await setup(), group = { groupid: 'group-UUID', name: '测试分组', sort: 0 };
    await s.app.repository(async (repository) => {
      repository.applyPage(s.app.scope, 'assets', { upserts: [], deletes: [], resources: [{ id: 'group-UUID', kind: 'assetGroup', raw: group }], pageState: null }, 'assets');
      s.upstream.respond(async () => new Response(s.upstream.calls.at(-1)!.url.includes('/asset_group/list') ? '{"ec":200,"data":{"list":[]}}' : '{"ec":200}'));
      const coordinator = new Coordinator({ repository, client: s.upstream.client, clock: s.clock }, new Map([['assets.groups.delete', createAssetGroupMutationHandler()]]));
      const result = await coordinator.submit({ action: 'assets.groups.delete', requestId: 'group-delete', scope: s.app.scope, input: { id: 'group-UUID', expectedVersion: billVersion(group) } }); expect(result.state).toBe('uncertain'); expect((await coordinator.reconcileOperation(s.app.scope, result.id)).state).toBe('succeeded');
      expect(repository.readResources(s.app.scope, 'assetGroup', { domain: 'assets', ids: ['group-UUID'] }).items).toHaveLength(0); expect(repository.readResources(s.app.scope, 'asset', { domain: 'assets', ids: ['10'] }).items).toHaveLength(1);
    });
  });
});
