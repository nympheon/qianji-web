import { expect, test } from '@playwright/test';
import { freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
const root = { id: '10', bookId: '10', type: 0, name: '餐饮', parentId: null, level: 1, sort: 0, editable: true, icon: '', childIds: ['11'], editVersion: 'a'.repeat(64) };
const child = { ...root, id: '11', name: '午餐', parentId: '10', level: 2, childIds: [] };
test('creates scoped category drafts and restores an unknown original without resending', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, writes = 0, received: unknown = null;
  await page.route('**/api/actions', async (route) => { const { action, input } = route.request().postDataJSON();
    const values: Record<string, unknown> = { 'books.list': ready({ items: [{ id: '10', name: '测试账本', visible: true }], freshness }, freshness), 'categories.list': ready({ items: [root, child], bookId: '10', type: 0, freshness }, freshness), 'capabilities.list': ready([{ action: 'categories.submit', enabled: true }]), 'categories.draft.get': ready(saved) };
    if (Object.hasOwn(values, action)) return route.fulfill({ json: values[action] });
    if (action === 'categories.draft.save') { saved = { draft: input.draft, operationId: null }; return route.fulfill({ json: ready(saved) }); }
    if (action === 'categories.submit') { writes++; received = input; saved = { ...(saved as object), operationId: 'category-original' }; return route.fulfill({ json: { status: 'uncertain', data: { id: 'category-original', state: 'uncertain', items: [], error: null }, freshness: null } }); }
    if (action === 'operations.get') return route.fulfill({ json: { status: 'uncertain', data: { id: 'category-original', state: 'uncertain', items: [], error: null }, freshness: null } });
    await route.fallback();
  });
  await page.goto('/categories'); await expect(page.getByRole('heading', { name: '分类', exact: true })).toBeVisible(); await page.getByRole('button', { name: '新增分类', exact: true }).click(); await page.getByLabel('分类名称').fill('测试餐饮');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-category-editor.png`), animations: 'disabled' });
  await page.getByRole('button', { name: '保存分类', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible(); expect(received).toMatchObject({ mode: 'create', bookId: '10', type: 0, name: '测试餐饮', parentId: null });
  await page.reload(); await page.getByRole('button', { name: '新增分类', exact: true }).click(); await expect(page.getByText('category-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存分类', exact: true })).toBeDisabled(); expect(writes).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('blocks parent deletion and shows official own and other-member counts before choosing a migration policy', async ({ page }) => {
  await mockReadApp(page);
  await page.route('**/api/actions', async (route) => { const { action } = route.request().postDataJSON(); const values: Record<string, unknown> = { 'books.list': ready({ items: [{ id: '10', name: '测试账本', visible: true }], freshness }, freshness), 'categories.list': ready({ items: [root, child], bookId: '10', type: 0, freshness }, freshness), 'capabilities.list': ready([{ action: 'categories.delete', enabled: true }]), 'categories.checkDelete': ready({ id: '11', count: 3, other: 2, hasChildren: false, blocked: false, expectedVersion: child.editVersion }), 'categories.draft.get': ready(null) }; if (Object.hasOwn(values, action)) return route.fulfill({ json: values[action] }); await route.fallback(); });
  await page.goto('/categories'); await expect(page.getByRole('button', { name: '删除分类 餐饮', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '删除分类 午餐', exact: true }).click(); await expect(page.getByText('本人 3 笔 · 其他成员 2 笔', { exact: true })).toBeVisible(); await page.getByRole('combobox', { name: '关联账单处理' }).click(); await expect(page.getByRole('option', { name: '删除本人关联账单', exact: true })).toBeVisible();
});
