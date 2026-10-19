import { test, expect, type Route } from '@playwright/test';
import { connection, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';

test('checks all three routes only on demand, shows individual results and preserves the selected route', async ({ page }, testInfo) => {
  await mockReadApp(page);
  const pending = new Map<string, Route>(), requests: string[] = [], mutations: string[] = [];
  let capabilities = 0;
  await page.route('**/api/actions', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'capabilities.list') capabilities++;
    if (body.action === 'connection.selectRoute') mutations.push(body.input.route);
    if (body.action !== 'connection.testRoute') return route.fallback();
    requests.push(body.input.route);
    pending.set(body.input.route, route);
  });
  await page.goto('/service');
  const table = page.getByRole('table', { name: '线路延迟检测' });
  await expect(table).toBeVisible();
  await expect(page.getByRole('heading', { name: '可用功能', exact: true })).toHaveCount(0);
  expect(capabilities).toBe(0); expect(requests).toEqual([]);
  const button = page.getByRole('button', { name: '检测三条线路', exact: true });
  await button.click();
  await expect.poll(() => [...requests].sort()).toEqual(['backup', 'main', 'overseas']);
  await expect(button).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '当前线路' })).toBeDisabled();
  await expect(table.getByText('检测中…', { exact: true })).toHaveCount(3);
  await pending.get('backup')!.fulfill({ json: ready({ route: 'backup', status: 'error', latencyMs: 22, error: { code: 'QIANJI_TIMEOUT', message: '钱迹请求超时' } }) });
  await expect(table.getByRole('row', { name: /备用线路/ })).toContainText('钱迹请求超时');
  await expect(table.getByRole('row', { name: /备用线路/ })).not.toContainText('22 ms');
  await expect(button).toBeDisabled();
  await pending.get('main')!.fulfill({ json: ready({ route: 'main', status: 'ok', latencyMs: 0, error: null }) });
  await expect(table.getByRole('row', { name: /主线路/ })).toContainText('0 ms');
  await pending.get('overseas')!.fulfill({ json: ready({ route: 'overseas', status: 'ok', latencyMs: 187, error: null }) });
  await expect(table.getByRole('row', { name: /海外线路/ })).toContainText('187 ms');
  await expect(button).toBeEnabled();
  await expect(page.getByRole('combobox', { name: '当前线路' })).toHaveText('主线路');
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-route-latency.png`), fullPage: true });
  await button.click();
  await expect.poll(() => requests.length).toBe(6);
  await expect(table.getByText('检测中…', { exact: true })).toHaveCount(3);
  await expect(table).not.toContainText('187 ms');
  for (const id of ['main', 'backup', 'overseas']) await pending.get(id)!.fulfill({ json: ready({ route: id, status: 'ok', latencyMs: 100, error: null }) });
  await expect(button).toBeEnabled();
  await expect(table.getByText('100 ms', { exact: true })).toHaveCount(3);
});

test('keeps the other route results when one HTTP request fails', async ({ page }) => {
  await mockReadApp(page);
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action !== 'connection.testRoute') return route.fallback();
    if (input.route === 'backup') return route.abort('failed');
    return route.fulfill({ json: ready({ route: input.route, status: 'ok', latencyMs: 250, error: null }) });
  });
  await page.goto('/service'); await page.getByRole('button', { name: '检测三条线路', exact: true }).click();
  const table = page.getByRole('table', { name: '线路延迟检测' });
  await expect(table.getByRole('row', { name: /备用线路/ })).toContainText('无法连接本服务');
  await expect(table.getByText('250 ms', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '检测三条线路', exact: true })).toBeEnabled();
});

test('requires a connected Qianji session before testing routes', async ({ page }) => {
  await mockReadApp(page);
  let checks = 0;
  await page.route('**/api/actions', async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === 'connection.status') return route.fulfill({ json: ready({ ...connection, state: 'needs_login' }) });
    if (action === 'connection.testRoute') checks++;
    return route.fallback();
  });
  await page.goto('/service');
  await expect(page.getByRole('button', { name: '检测三条线路', exact: true })).toBeDisabled();
  expect(checks).toBe(0);
});
