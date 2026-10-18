import { expect, test } from '@playwright/test';
import { freshness, mockReadApp, ready, detail, ledger } from './read-fixtures';
import { join } from 'node:path';
const asset = { id: '100', name: '专用测试借入', type: 5, subtype: 51, currency: 'CNY', money: '-100', status: 0, visible: true, finished: false, inCount: true, groupId: null, remark: '', editVersion: 'a'.repeat(64), knownType: true };
const debt = { asset, state: { direction: 'borrow', balance: '-100', totalPrincipal: '-100', totalPaid: '0' }, aboutAssetId: '10', startDate: '2026-01-01', endDate: null, loanInfoMissing: false };
test('previews native overpayment, saves original request key and restores an uncertain debt operation', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, received: unknown = null, writes = 0;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'debt.list') { await route.fulfill({ json: ready({ items: input.direction === 'borrow' && !input.finished ? [debt] : [], freshness }, freshness) }); return; }
    if (action === 'debt.options') { await route.fulfill({ json: ready({ assets: [{ id: '10', name: '测试现金', type: 1, currency: 'CNY', money: '1000', lastPayTimeSec: '0' }], books: [{ id: '1', name: '专用测试账本' }], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'debt.pay', enabled: true, reason: null }]) }); return; }
    if (action === 'debt.draft.get') { await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'debt.draft.save') { saved = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'debt.pay') { received = input; writes++; saved = { ...(saved as object), operationId: 'debt-original' }; await route.fulfill({ json: { status: 'uncertain', data: { id: 'debt-original', action, state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'debt-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    await route.fallback();
  });
  await page.goto('/debt'); await expect(page.getByRole('heading', { name: '借贷', exact: true })).toBeVisible(); await page.getByRole('button', { name: '还款 专用测试借入', exact: true }).click();
  await page.getByLabel('本金金额').fill('120'); await expect(page.getByText('超出本金余额的金额将计为利息：本金 100，利息 20。', { exact: true })).toBeVisible(); await page.getByLabel('操作备注').fill('隔离测试还款');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-debt-editor.png`), animations: 'disabled' });
  await page.getByRole('button', { name: '确认还款', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible(); expect(received).toMatchObject({ id: '100', principal: '120', interest: '0', aboutAssetId: '10', remark: '隔离测试还款' });
  await page.reload(); await page.getByRole('button', { name: '还款 专用测试借入', exact: true }).click(); await expect(page.getByText('debt-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '确认还款', exact: true })).toBeDisabled(); expect(writes).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('marks missing loan information and provides no guessed payment form', async ({ page }) => {
  await mockReadApp(page); await page.route('**/api/actions', async (route) => { const { action } = route.request().postDataJSON(); if (action === 'debt.list') { await route.fulfill({ json: ready({ items: [{ ...debt, state: null, loanInfoMissing: true }], freshness }) }); return; } await route.fallback(); });
  await page.goto('/debt'); await expect(page.getByText('借贷资料不完整，请先刷新或在手机客户端核查。', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '还款 专用测试借入', exact: true })).toBeDisabled();
});
test('routes native principal edits to the debt editor and preserves principal ID and debt relationship', async ({ page }) => {
  await mockReadApp(page); const principal = { ...detail, id: '900', type: 6, money: '100', bookId: '1', assetId: '100', targetId: '10', fromId: null, remark: '测试本金', editVersion: 'b'.repeat(64) }; let received: unknown = null;
  await page.route('**/api/actions', async (route) => { const { action, input } = route.request().postDataJSON(); const values: Record<string, unknown> = { 'ledger.list': ready({ ...ledger, items: [principal], rows: [{ kind: 'bill', bill: principal }] }, freshness), 'ledger.detail': ready(principal, freshness), 'capabilities.list': ready([{ action: 'debt.editPrincipal', enabled: true, reason: null }]), 'ledger.transfer.options': ready({ assets: [{ id: '10', name: '测试现金', type: 1, currency: 'CNY', money: '1000', lastPayTimeSec: '0' }], books: [{ id: '1', name: '专用测试账本' }], baseCurrency: 'CNY', complete: true, freshness }), 'debt.draft.get': ready(null), 'debt.draft.save': ready({ draft: input.draft, operationId: null }) }; if (Object.hasOwn(values, action)) { await route.fulfill({ json: values[action] }); return; } if (action === 'debt.editPrincipal') { received = input; await route.fulfill({ json: ready({ id: 'edit-debt', state: 'succeeded', items: [], error: null }) }); return; } if (action === 'operations.get') { await route.fulfill({ json: ready({ id: 'edit-debt', state: 'succeeded', items: [], error: null }) }); return; } await route.fallback(); });
  await page.goto('/bills'); await page.getByRole('button', { name: '查看 测试本金', exact: true }).filter({ visible: true }).click(); await page.getByRole('button', { name: '编辑账单', exact: true }).click(); await page.getByLabel('本金金额').fill('150'); await page.getByRole('button', { name: '保存本金记录', exact: true }).click(); await expect.poll(() => received).toMatchObject({ id: '900', expectedVersion: principal.editVersion, changes: { principal: '150', aboutAssetId: '10', bookId: '1' } });
});
