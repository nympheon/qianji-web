import { test, expect } from '@playwright/test';
import { freshness, ledger, mockReadApp } from './read-fixtures';
import { join } from 'node:path';
test('filters bills, opens accessible details, navigates calendar and statistics without overflow', async ({ page }, testInfo) => {
  await mockReadApp(page); await page.goto('/bills');
  await expect(page.getByRole('heading', { name: '账单', exact: true })).toBeVisible(); await expect(page.getByText('午餐', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-bills.png`) });
  await page.getByRole('button', { name: '同步', exact: true }).click(); await expect(page.getByText('午餐', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '筛选', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: /查看.*午餐/ }).first().click(); await expect(page.getByRole('dialog')).toContainText('账单详情'); await page.keyboard.press('Escape');
  await page.getByRole('link', { name: '日历', exact: true }).click(); await expect(page.getByRole('heading', { name: '日历', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: /2026-01-20/ })).toBeVisible();
  await page.getByRole('link', { name: '统计', exact: true }).click(); await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible(); await expect(page.getByTestId('total-spend')).toContainText('90.00');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-statistics.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '同步', exact: true })).toHaveCSS('background-color', 'rgb(246, 189, 85)');
});
test('keeps confirmed bills visible during a slow sync and only polls the existing job', async ({ page }) => {
  await mockReadApp(page); let listCalls = 0, statusCalls = 0;
  await page.route('**/api/actions', async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === 'ledger.list') { listCalls++; await route.fulfill({ json: { status: 'running', data: ledger, freshness: { ...freshness, stale: true }, jobId: 'slow' } }); return; }
    if (action === 'sync.status') { statusCalls++; await route.fulfill({ json: { status: statusCalls >= 10 ? 'error' : 'running', data: { id: 'slow', state: statusCalls >= 10 ? 'failed' : 'running' }, freshness: null, jobId: 'slow', ...(statusCalls >= 10 ? { error: { code: 'QIANJI_TIMEOUT', message: '钱迹请求超时' } } : {}) } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await expect(page.getByText('午餐', { exact: true }).filter({ visible: true }).first()).toBeVisible(); await expect(page.getByText(/正在更新/).first()).toBeVisible();
  for (let i = 0; i < 10; i++) { await page.clock.runFor(2100); await page.waitForTimeout(30); }
  await expect(page.getByText('钱迹请求超时').first()).toBeVisible(); await expect(page.getByText('午餐', { exact: true }).filter({ visible: true }).first()).toBeVisible(); await page.clock.runFor(120_000); expect(listCalls).toBe(1); expect(statusCalls).toBe(10);
});
test('accumulates calendar continuation pages instead of replacing earlier day counts', async ({ page }) => {
  await mockReadApp(page);
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON(); if (action !== 'ledger.calendar') { await route.fallback(); return; }
    await route.fulfill({ json: { status: 'ready', freshness, data: { days: [{ date: '2026-01-20', count: input.cursor ? 2 : 1 }], complete: !!input.cursor, nextCursor: input.cursor ? null : 'next', freshness, range: { startSec: 1767196800, endSec: 1769875199, zone: 'Asia/Shanghai' } } } });
  });
  await page.goto('/calendar'); await expect(page.getByRole('button', { name: '2026-01-20 · 1 笔账单' })).toBeVisible();
  await page.getByRole('button', { name: '继续计算本月日历' }).click(); await expect(page.getByRole('button', { name: '2026-01-20 · 3 笔账单' })).toBeVisible();
});
