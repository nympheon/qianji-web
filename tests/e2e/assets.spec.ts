import { expect, test } from '@playwright/test';
import { freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
const asset = { id: '10', name: '测试现金', type: 1, subtype: 11, currency: 'CNY', money: '100', status: 0, visible: true, finished: false, inCount: true, groupId: null, remark: '', editVersion: 'a'.repeat(64), knownType: true };
const list = { items: [asset], groups: [], nextCursor: null, summary: { currencies: [{ currency: 'CNY', assets: '100', liabilities: '0', borrowed: '0', lent: '0', net: '100', installments: '0' }], complete: true, incompleteReasons: [] }, freshness };
test('creates an asset with a persistent request key and restores the same unknown operation', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, sent = 0, received: unknown = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'assets.list') { await route.fulfill({ json: ready(list, freshness) }); return; }
    if (action === 'assets.types') { await route.fulfill({ json: ready({ items: [{ type: 1, subtype: 11, name: '现金', group: '资金账户', icon: '', color: '' }], freshness }) }); return; }
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'assets.submit', enabled: true, reason: null }]) }); return; }
    if (action === 'assets.draft.get') { await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'assets.draft.save') { saved = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'assets.submit') { sent++; received = input; saved = { ...(saved as object), operationId: 'asset-original' }; await route.fulfill({ json: { status: 'uncertain', data: { id: 'asset-original', action, state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'asset-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    await route.fallback();
  });
  await page.goto('/assets'); await expect(page.getByRole('heading', { name: '资产', exact: true })).toBeVisible(); await page.getByRole('button', { name: '新增资产', exact: true }).click();
  await page.getByLabel('资产名称').fill('专用测试现金'); await page.getByLabel('初始余额').fill('50');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-asset-editor.png`), animations: 'disabled' });
  await page.getByRole('button', { name: '保存资产', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible(); expect(received).toMatchObject({ mode: 'create', fields: { name: '专用测试现金', money: '50', type: 1, subtype: 11, currency: 'CNY' } });
  await page.reload(); await page.getByRole('button', { name: '新增资产', exact: true }).click(); await expect(page.getByText('asset-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存资产', exact: true })).toBeDisabled(); expect(sent).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('shows native deletion dependencies and prevents deletion of an asset still used by a plan', async ({ page }) => {
  await mockReadApp(page); let writes = 0;
  await page.route('**/api/actions', async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === 'assets.list') { await route.fulfill({ json: ready(list, freshness) }); return; }
    if (action === 'assets.detail') { await route.fulfill({ json: ready({ asset, freshness }) }); return; }
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'assets.delete', enabled: true, reason: null }]) }); return; }
    if (action === 'assets.deleteCheck') { await route.fulfill({ json: ready({ id: '10', installCount: 1, repeatCount: 0, nativeCheckSkipped: false, blocked: true, deleteBillIds: [], retainedBillIds: ['99'], expectedVersion: asset.editVersion }) }); return; }
    if (action === 'assets.draft.get') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'assets.delete') { writes++; }
    await route.fallback();
  });
  await page.goto('/assets'); await page.getByRole('button', { name: '查看资产 测试现金' }).click(); await page.getByRole('button', { name: '删除资产', exact: true }).click();
  await expect(page.getByText('仍关联 1 个分期、0 个周期账单')).toBeVisible(); await expect(page.getByRole('button', { name: '确认删除资产', exact: true })).toBeDisabled(); expect(writes).toBe(0);
});
test('keeps selected Shanghai history dates stable and sends real day boundaries', async ({ page }) => {
  await mockReadApp(page); let last: { fromSec: number; toSec: number } | null = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'assets.list') { await route.fulfill({ json: ready(list, freshness) }); return; }
    if (action === 'assets.detail') { await route.fulfill({ json: ready({ asset, freshness }) }); return; }
    if (action === 'assets.trend') { last = input; await route.fulfill({ json: ready({ id: '10', currency: 'CNY', points: [], freshness }) }); return; }
    await route.fallback();
  });
  await page.goto('/assets'); await page.getByRole('button', { name: '查看资产 测试现金' }).click(); await page.getByRole('button', { name: '历史资产趋势', exact: true }).click();
  await page.getByLabel('开始日期').fill('2026-01-10'); await expect(page.getByLabel('开始日期')).toHaveValue('2026-01-10'); await page.getByLabel('结束日期').fill('2026-01-20');
  await expect.poll(() => last).toMatchObject({ fromSec: Date.parse('2026-01-10T00:00:00+08:00') / 1000, toSec: Date.parse('2026-01-20T23:59:59+08:00') / 1000 });
});
test('a later opposite visibility request gets its own draft and preserves the newly requested target', async ({ page }) => {
  await mockReadApp(page); let visible = true; const saved = new Map<string, { draft: object; operationId: string | null }>(), targets: boolean[] = [];
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON(), current = { ...asset, visible, status: visible ? 0 : 2 };
    if (action === 'assets.list') { await route.fulfill({ json: ready({ ...list, items: input.status === current.status ? [current] : [] }, freshness) }); return; }
    if (action === 'assets.detail') { await route.fulfill({ json: ready({ asset: current, freshness }) }); return; }
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'assets.setVisible', enabled: true, reason: null }]) }); return; }
    if (action === 'assets.draft.get') { await route.fulfill({ json: ready(saved.get(input.key) ?? null) }); return; }
    if (action === 'assets.draft.save') { const value = { draft: input.draft, operationId: null }; saved.set(input.key, value); await route.fulfill({ json: ready(value) }); return; }
    if (action === 'assets.setVisible') { visible = input.visible; targets.push(visible); for (const value of saved.values()) if ('requestId' in value.draft && value.draft.requestId === input.requestId) value.operationId = `visible-${targets.length}`; await route.fulfill({ json: ready({ id: `visible-${targets.length}`, action, state: 'succeeded', items: [], error: null }) }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: ready({ id: input.operationId, state: 'succeeded', items: [], error: null }) }); return; }
    await route.fallback();
  });
  await page.goto('/assets'); await page.getByRole('button', { name: '查看资产 测试现金' }).click(); await page.getByRole('button', { name: '隐藏资产', exact: true }).click(); await page.getByRole('button', { name: '确认资产显隐', exact: true }).click(); await expect(page.getByText('操作已完成', { exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '隐藏资产', exact: true }).click(); await page.getByRole('button', { name: '查看资产 测试现金' }).click(); await page.getByRole('button', { name: '恢复显示', exact: true }).click(); await expect(page.getByRole('button', { name: '确认资产显隐', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '确认资产显隐', exact: true }).click(); await expect.poll(() => targets).toEqual([false, true]);
});
