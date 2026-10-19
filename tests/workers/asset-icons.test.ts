import { expect, it } from 'vitest';
import { createTestApp } from '../support/app';
import { createActorContext } from '../../src/actor/context';
import { assetView } from '../../src/features/assets/model';
import { ResourceCache } from '../../src/storage/cache';
import { TestClock } from '../support/upstream';
import { uploadImageSchema } from '../../src/features/attachments/contract';

const mastercard = 'http://res.qianjiapp.com/bank_wsd.png';
const postal = 'http://res3.qianjiapp.com/ic_bank_youzheng2.png';

it('preserves official card artwork and background metadata in the public asset view', () => {
  const view = assetView({ id: '10', name: '卡片', money: '100', type: 2, stype: 21, status: 0, icon: mastercard, color: 'FFFFFF' });
  expect(view).toMatchObject({ icon: mastercard, color: 'FFFFFF', type: 2 });
});

it('proxies only exact official icons belonging to the current account or official asset catalog', async () => {
  const app = await createTestApp();
  await app.repository((repository) => {
    const cache = new ResourceCache(repository, new TestClock());
    cache.confirmResources(app.scope, 'assets', [{ id: '10', kind: 'asset', raw: { id: '10', icon: mastercard } }]);
    const key = { domain: 'catalogs', queryKey: 'asset:types', resourceKind: 'assetType' } as const;
    cache.applyRead(cache.captureRead(app.scope, key), { items: [{ id: '1:12', kind: 'assetType', raw: { type: { type: 1, stype: 12, icon: postal } } }], complete: true });
    const attachments = createActorContext(repository.storage).attachments;
    expect(attachments.source({ reference: mastercard, purpose: 'asset' })).toBe(mastercard);
    expect(attachments.source({ reference: postal, purpose: 'asset' })).toBe(postal);
    expect(attachments.resolve({ reference: mastercard, purpose: 'asset' }).url).toBe('/api/images?' + new URLSearchParams({ reference: mastercard, purpose: 'asset', size: 'medium' }));
    for (const reference of ['http://res.qianjiapp.com/not-in-account.png', 'http://res.qianjiapp.com:8787/bank_wsd.png', 'http://127.0.0.1/private.png', mastercard + '?redirect=http://127.0.0.1', mastercard + '#fragment']) {
      expect(() => attachments.source({ reference, purpose: 'asset' })).toThrow();
    }
  });
  expect(uploadImageSchema.safeParse({ purpose: 'asset', mime: 'image/png', dataBase64: 'AA==' }).success).toBe(false);
});

it('revokes an icon that was removed from the latest official type snapshot', async () => {
  const app = await createTestApp();
  await app.repository((repository) => {
    const cache = new ResourceCache(repository, new TestClock()), key = { domain: 'catalogs', queryKey: 'asset:types', resourceKind: 'assetType' } as const;
    cache.applyRead(cache.captureRead(app.scope, key), { items: [{ id: '1:12', kind: 'assetType', raw: { type: { type: 1, stype: 12, icon: postal } } }], complete: true });
    const attachments = createActorContext(repository.storage).attachments;
    expect(attachments.source({ reference: postal, purpose: 'asset' })).toBe(postal);
    cache.applyRead(cache.captureRead(app.scope, key), { items: [], complete: true });
    expect(() => attachments.source({ reference: postal, purpose: 'asset' })).toThrow();
  });
});
