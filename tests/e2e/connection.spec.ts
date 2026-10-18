import { test, expect } from '@playwright/test';
import { connection, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
test('connects with a keyboard, clears the password and exposes server errors', async ({ page }, testInfo) => {
  await mockReadApp(page, false); let attempts = 0;
  await page.route('**/api/connection/login', async (route) => {
    const body = route.request().postDataJSON(); expect(body).toEqual({ account: 'person@example.test', password: 'NON_REAL_PASSWORD' }); attempts++;
    await route.fulfill({ json: attempts === 1 ? { status: 'error', data: null, freshness: null, error: { code: 'QIANJI_NETWORK_ERROR', message: '无法连接钱迹服务' } } : ready(connection) });
  });
  await page.goto('/connection'); await expect(page.getByRole('heading', { name: '连接钱迹' })).toBeVisible();
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-connection.png`) });
  await page.getByLabel('手机号或邮箱', { exact: true }).fill('person@example.test'); await page.getByLabel('密码', { exact: true }).fill('NON_REAL_PASSWORD');
  await page.getByLabel('密码', { exact: true }).press('Enter'); await expect(page.getByRole('alert')).toContainText('无法连接钱迹服务'); await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.getByLabel('密码', { exact: true }).fill('NON_REAL_PASSWORD'); await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '账单', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
