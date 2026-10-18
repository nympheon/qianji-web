import { expect, test, type Page } from '@playwright/test';
import { freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4f4zhPwAHUgLFUdoASgAAAABJRU5ErkJggg==', 'base64'), key = '_' + 'a'.repeat(32);
async function fixture(page: Page, unknown: boolean) {
  await mockReadApp(page); let billDraft: unknown = null, imageDraft: unknown = null, uploads = 0, state = unknown ? 'uncertain' : 'succeeded'; const operation = () => ({ id: 'image-original', action: 'attachments.upload', state, items: [], affectedIds: [], idMap: {}, error: null });
  await page.route('**/test-image.png', (route) => route.fulfill({ body: png, contentType: 'image/png' }));
  await page.route('**/api/actions', async (route) => { const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') return route.fulfill({ json: ready(['ledger.create', 'attachments.upload'].map((action) => ({ action, enabled: true }))) });
    if (action === 'attachments.options') return route.fulfill({ json: ready({ maxBillImages: 2, maxBytes: 8388608, countSource: 'qianji', uploadPage: '/attachments', freshness }, freshness) });
    if (action === 'attachments.draft.get') return route.fulfill({ json: ready(imageDraft) });
    if (action === 'attachments.draft.save') { imageDraft = { draft: input.draft, operationId: null, appliedKey: null }; return route.fulfill({ json: ready(imageDraft) }); }
    if (action === 'attachments.draft.applied') { imageDraft = { ...(imageDraft as object), appliedKey: key }; return route.fulfill({ json: ready(imageDraft) }); }
    if (action === 'attachments.result') return route.fulfill({ json: ready(state === 'succeeded' ? { key, associationValue: key, purpose: 'bill', mime: 'image/jpeg', width: 1, height: 1, bytesLength: 100, sha256: 'a'.repeat(64), etag: 'a'.repeat(28), sourceUrl: 'https://billimg.qianjiapp.com/' + key, proof: 'qiniu-receipt', createdAt: '2026-10-18T00:00:00Z' } : null) });
    if (action === 'attachments.resolve') return route.fulfill({ json: ready({ key: input.reference, url: '/test-image.png', uploaded: true, source: 'qianji-key' }) });
    if (action === 'ledger.draft.get') return route.fulfill({ json: ready(billDraft) });
    if (action === 'ledger.draft.save') { billDraft = { draft: input.draft, operationId: null }; return route.fulfill({ json: ready(billDraft) }); }
    if (action === 'ledger.create') return route.fulfill({ json: { status: 'error', data: null, freshness: null, error: { code: 'QIANJI_RESTRICTED', message: '测试中的业务拒绝' } } });
    if (action === 'operations.reconcile') { state = 'succeeded'; return route.fulfill({ json: ready(operation()) }); }
    if (action === 'operations.get') return route.fulfill({ json: { status: state === 'succeeded' ? 'ready' : 'uncertain', data: operation(), freshness: null } });
    await route.fallback();
  });
  await page.route('**/api/uploads', async (route) => { uploads++; expect(route.request().headers()['content-type']).toContain('multipart/form-data'); expect(route.request().postDataBuffer()?.toString('latin1')).toContain('image/jpeg'); imageDraft = { ...(imageDraft as object), operationId: 'image-original' }; await route.fulfill({ json: { status: unknown ? 'uncertain' : 'ready', data: operation(), freshness: null } }); });
  return { uploads: () => uploads, billDraft: () => billDraft };
}
test('keeps a confirmed image in the bill draft when saving the bill fails and does not reupload it on reload', async ({ page }, testInfo) => {
  const state = await fixture(page, false); await page.goto('/bills'); await page.getByRole('button', { name: '记一笔', exact: true }).click(); await expect(page.getByText('图片附件', { exact: true })).toBeVisible(); await page.getByLabel('添加图片').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png }); await expect.poll(() => state.billDraft()).toMatchObject({ draft: { fields: { images: [key] } } }); await expect(page.getByRole('img', { name: '图片1', exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole('img', { name: '图片1', exact: true }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
  if (process.env.QIANJI_VISUAL_DIR) { await page.getByRole('group', { name: '图片附件' }).evaluate((element) => element.scrollIntoView({ block: 'center' })); await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-bill-attachments.png`), animations: 'disabled' }); }
  await page.getByLabel('录入金额').fill('10'); await page.getByRole('button', { name: '保存账单', exact: true }).click(); await expect(page.getByText('测试中的业务拒绝', { exact: true })).toBeVisible(); await page.reload(); await page.getByRole('button', { name: '记一笔', exact: true }).click(); await expect(page.getByRole('img', { name: '图片1', exact: true })).toBeVisible(); expect(state.uploads()).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('does not restore a previously applied image after the user removes it and reloads', async ({ page }) => {
  const state = await fixture(page, false); await page.goto('/bills'); await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('添加图片').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: '移除图片1', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '移除图片1', exact: true }).click();
  await expect.poll(() => state.billDraft()).toMatchObject({ draft: { fields: { images: [] } } }); await page.reload(); await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存账单', exact: true })).toBeEnabled(); await expect(page.getByRole('img', { name: '图片1', exact: true })).toHaveCount(0); expect(state.uploads()).toBe(1);
});
test('blocks bill submission while the original upload is unknown and attaches the proved result only once', async ({ page }) => {
  const state = await fixture(page, true); await page.goto('/bills'); await page.getByRole('button', { name: '记一笔', exact: true }).click(); await expect(page.getByText('图片附件', { exact: true })).toBeVisible(); await page.getByLabel('添加图片').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png }); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存账单', exact: true })).toBeDisabled(); await page.reload(); await page.getByRole('button', { name: '记一笔', exact: true }).click(); await expect(page.getByText('image-original', { exact: true })).toBeVisible(); await expect(page.getByLabel('添加图片')).toBeDisabled(); await page.getByRole('button', { name: '核查原操作', exact: true }).click(); await expect.poll(() => state.billDraft()).toMatchObject({ draft: { fields: { images: [key] } } }); await expect(page.getByRole('button', { name: '保存账单', exact: true })).toBeEnabled(); expect(state.uploads()).toBe(1);
});
test('provides a web upload entry for MCP and recovers its latest confirmed key', async ({ page }) => {
  const state = await fixture(page, false); await page.goto('/attachments'); await expect(page.getByRole('heading', { name: '图片上传', exact: true })).toBeVisible(); await page.getByLabel('添加图片').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: png }); await expect(page.getByText(key, { exact: true })).toBeVisible(); await page.reload(); await expect(page.getByText(key, { exact: true })).toBeVisible(); expect(state.uploads()).toBe(1);
});
