import { expect, test } from '@playwright/test';
import { detail, freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
const source = { ...detail, type: 5, editVersion: 'a'.repeat(64) };
test('persists reimbursement input and restores the original unknown operation after reload', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, sent = 0, received: unknown = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.reimburse', enabled: true, reason: null }]) }); return; }
    if (action === 'ledger.list') { await route.fulfill({ json: ready({ items: [source], rows: [{ kind: 'bill', bill: source }], nextCursor: null, range: null, freshness }, freshness) }); return; }
    if (action === 'ledger.detail') { await route.fulfill({ json: ready(source, freshness) }); return; }
    if (action === 'ledger.transfer.options') { await route.fulfill({ json: ready({ assets: [], books: [], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'ledger.draft.save') { saved = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'ledger.reimburse') { sent++; received = input; saved = { ...(saved as object), operationId: 'reimburse-original' }; await route.fulfill({ json: { status: 'uncertain', data: { id: 'reimburse-original', state: 'uncertain', action, items: [], error: null }, freshness: null } }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'reimburse-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    await route.fallback();
  });
  await page.goto('/reimbursements'); await page.getByLabel('选择 午餐').click(); await expect(page.getByLabel('选择 午餐')).toBeChecked(); await page.getByLabel('报销总额').fill('120'); await page.getByLabel('报销备注').fill('差旅报销');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-reimbursement-editor.png`) });
  await page.getByRole('button', { name: '确认报销入账', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible();
  expect(received).toMatchObject({ bills: [{ id: source.id, expectedVersion: 'a'.repeat(64) }], money: '120', assetId: null, remark: '差旅报销' });
  await page.reload(); await expect(page.getByText('reimburse-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '确认报销入账', exact: true })).toBeDisabled(); expect(sent).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('refuses to select a truncated reimbursement group as if it were complete', async ({ page }) => {
  await mockReadApp(page); let reads = 0;
  await page.route('**/api/actions', async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'ledger.draft.save') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'ledger.list') { await route.fulfill({ json: ready({ items: [], rows: [{ kind: 'reimbursement-group', displayType: 22, packId: '123', members: [source], memberIds: [source.id], continuedAfter: true, continuedBefore: false }], nextCursor: null, freshness }, freshness) }); return; }
    if (action === 'ledger.reimbursement.members') { reads++; await route.fulfill({ json: ready({ packId: '123', items: [source], complete: false, freshness: { ...freshness, complete: false } }) }); return; }
    await route.fallback();
  });
  await page.goto('/reimbursements'); await page.getByRole('button', { name: '报销到账', exact: true }).click(); await page.getByRole('button', { name: '选择完整组合 123' }).click();
  await expect(page.getByRole('alert')).toContainText('组合成员尚未完整载入'); expect(reads).toBe(1); await expect(page.getByText('已选择 0 笔', { exact: true })).toBeVisible();
});
