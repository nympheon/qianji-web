import { expect, test } from '@playwright/test';
import { detail, freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
const source = { ...detail, editVersion: 'a'.repeat(64) }, childId = '1792000000123100044';

test('creates a dedicated refund and recovers the same source-scoped draft after an unknown result', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, sent = 0, received: unknown = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.refund', enabled: true, reason: null }]) }); return; }
    if (action === 'ledger.transfer.options') { await route.fulfill({ json: ready({ assets: [], books: [{ id: '10', name: '日常账本' }], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'ledger.detail') { await route.fulfill({ json: ready(source, freshness) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'ledger.draft.save') { saved = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'ledger.refund') { sent++; received = input; saved = { ...(saved as object), operationId: 'refund-original' }; await route.fulfill({ json: { status: 'uncertain', data: { id: 'refund-original', state: 'uncertain', action, items: [], error: null }, freshness: null, operationId: 'refund-original' } }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'refund-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: /查看.*午餐/ }).first().click(); await page.getByRole('button', { name: '新增退款', exact: true }).click();
  await page.getByLabel('退款金额').fill('30'); await page.getByLabel('退款备注').fill('部分退款');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-refund-editor.png`) });
  await page.getByRole('button', { name: '保存退款', exact: true }).click();
  await expect(page.getByText('结果待核查', { exact: true })).toBeVisible();
  expect(received).toMatchObject({ billId: source.id, expectedVersion: 'a'.repeat(64), money: '30', assetId: null, remark: '部分退款' }); expect(received).not.toHaveProperty('refundBillId');
  await page.reload(); await page.getByRole('button', { name: /查看.*午餐/ }).first().click(); await page.getByRole('button', { name: '新增退款', exact: true }).click();
  await expect(page.getByText('refund-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存退款', exact: true })).toBeDisabled(); expect(sent).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('edits the child through refund2 inputs and reports unsupported clearing explicitly', async ({ page }) => {
  await mockReadApp(page); let edited: unknown = null;
  const refund = { ...detail, id: childId, type: 20, money: '30', remark: '保留备注', refundSourceId: source.id, editVersion: 'b'.repeat(64) };
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.refund', enabled: true, reason: null }]) }); return; }
    if (action === 'ledger.list') { await route.fulfill({ json: ready({ items: [refund], rows: [{ kind: 'bill', bill: refund }], nextCursor: null, range: null, freshness, incompleteReasons: [] }, freshness) }); return; }
    if (action === 'ledger.detail') { await route.fulfill({ json: ready(input.id === childId ? refund : source, freshness) }); return; }
    if (action === 'ledger.transfer.options') { await route.fulfill({ json: ready({ assets: [], books: [], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'ledger.draft.save') { await route.fulfill({ json: ready({ draft: input.draft, operationId: null }) }); return; }
    if (action === 'ledger.refund') { edited = input; await route.fulfill({ json: { status: 'error', data: { id: 'refund-edit', state: 'failed', action, items: [], error: { code: 'REFUND_CLEAR_UNVERIFIED', message: '该退款字段的清空语义尚待真实验证，请保留原值' } }, freshness: null, operationId: 'refund-edit' } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: /查看.*保留备注/ }).first().click(); await page.getByRole('button', { name: '编辑账单', exact: true }).click();
  await page.getByLabel('退款备注').fill(''); await page.getByRole('button', { name: '保存退款', exact: true }).click();
  await expect(page.getByText('该退款字段的清空语义尚待真实验证，请保留原值').first()).toBeVisible();
  expect(edited).toMatchObject({ billId: source.id, refundBillId: childId, expectedVersion: 'a'.repeat(64), refundExpectedVersion: 'b'.repeat(64), remark: '' });
});
