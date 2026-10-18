import { expect, test } from '@playwright/test';
import { freshness, mockReadApp, ready, statistics } from './read-fixtures';
import { join } from 'node:path';
const owner = { id: '10', name: '专用测试账本', type: 1, visible: true, sort: 0, ownerId: 'test', memberId: 'test', role: 'owner', defaultBook: false, expiredAsOwner: false, expiredAsMember: false, memberCount: 1, range: 'm10', cover: null, editVersion: 'a'.repeat(64) };
test('creates a book using a typed persistent draft and restores the original unknown operation', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, writes = 0, received: unknown = null;
  await page.route('**/api/actions', async (route) => { const { action, input } = route.request().postDataJSON();
    const values: Record<string, unknown> = { 'books.list': ready({ items: [owner], freshness }, freshness), 'books.types': ready({ items: [{ type: 1, name: '日常', cover: 'https://example.test/book.jpg', description: '日常收支', range: '' }], freshness }), 'capabilities.list': ready([{ action: 'books.submit', enabled: true, reason: null }]), 'books.draft.get': ready(saved) };
    if (Object.hasOwn(values, action)) { await route.fulfill({ json: values[action] }); return; }
    if (action === 'books.draft.save') { saved = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'books.submit') { writes++; received = input; saved = { ...(saved as object), operationId: 'book-original' }; await route.fulfill({ json: { status: 'uncertain', data: { id: 'book-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'book-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; } await route.fallback();
  });
  await page.goto('/books'); await expect(page.getByRole('heading', { name: '账本', exact: true })).toBeVisible(); await page.getByRole('button', { name: '新增账本', exact: true }).click(); await page.getByLabel('账本名称').fill('隔离验收账本');
  if (process.env.QIANJI_VISUAL_DIR) await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-book-editor.png`), animations: 'disabled' });
  await page.getByRole('button', { name: '保存账本', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible(); expect(received).toMatchObject({ mode: 'create', type: 1, name: '隔离验收账本' });
  await page.reload(); await page.getByRole('button', { name: '新增账本', exact: true }).click(); await expect(page.getByText('book-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存账本', exact: true })).toBeDisabled(); expect(writes).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('shows separate owner/member unresolved flags and prevents book deletion while either remains', async ({ page }) => {
  await mockReadApp(page); let writes = 0;
  await page.route('**/api/actions', async (route) => { const { action } = route.request().postDataJSON(); const values: Record<string, unknown> = { 'books.list': ready({ items: [owner], freshness }, freshness), 'capabilities.list': ready([{ action: 'books.delete', enabled: true, reason: null }]), 'books.deleteCheck': ready({ id: '10', role: 'owner', defaultBook: false, expectedVersion: owner.editVersion, ownerHasUnresolved: false, memberHasUnresolved: true, blocked: true }), 'books.draft.get': ready(null) }; if (Object.hasOwn(values, action)) { await route.fulfill({ json: values[action] }); return; } if (action === 'books.delete') writes++; await route.fallback(); });
  await page.goto('/books'); await page.getByRole('button', { name: '删除账本 专用测试账本', exact: true }).click(); await expect(page.getByText('成员仍有未结事项', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '确认删除云端账本', exact: true })).toBeDisabled(); expect(writes).toBe(0);
});
test('exposes self-quit for a shared member and protects the default book from delete and quit', async ({ page }) => {
  await mockReadApp(page); const shared = { ...owner, id: '20', name: '共享账本', role: 'member', ownerId: 'other', expiredAsMember: true }, defaultBook = { ...owner, id: '-1', name: '默认账本', defaultBook: true };
  await page.route('**/api/actions', async (route) => { const { action } = route.request().postDataJSON(); if (action === 'books.list') { await route.fulfill({ json: ready({ items: [shared, defaultBook], freshness }, freshness) }); return; } if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'books.quit', enabled: true, reason: null }, { action: 'books.delete', enabled: true, reason: null }]) }); return; } await route.fallback(); });
  await page.goto('/books'); await expect(page.getByRole('button', { name: '退出账本 共享账本', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: '删除账本 共享账本', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '删除账本 默认账本', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '退出账本 默认账本', exact: true })).toHaveCount(0); await expect(page.getByText('成员资格已过期', { exact: true })).toBeVisible();
});
test('uses the shared configured base currency in overview, bills and statistics', async ({ page }) => {
  await mockReadApp(page); const currencies: string[] = [];
  await page.route('**/api/actions', async (route) => { const { action, input } = route.request().postDataJSON(); if (action === 'ledger.options') { await route.fulfill({ json: ready({ books: [], categories: [], tags: [], complete: true, baseCurrency: 'USD' }) }); return; } if (action === 'ledger.statistics') { currencies.push(input.currency); await route.fulfill({ json: ready({ ...statistics, currency: input.currency }, freshness) }); return; } await route.fallback(); });
  for (const path of ['/', '/bills', '/statistics']) { await page.goto(path); await expect(page.getByTestId('total-spend')).toHaveText('$ 90.00'); } expect(currencies).toContain('USD');
});
test('includes hidden books only after an explicit filter selection', async ({ page }) => {
  await mockReadApp(page); let last: unknown = null;
  await page.route('**/api/actions', async (route) => { const { action, input } = route.request().postDataJSON(); if (action === 'ledger.options') { await route.fulfill({ json: ready({ books: [{ id: '20', name: '隐藏测试账本', visible: false }], categories: [], tags: [], complete: true }) }); return; } if (action === 'ledger.list') last = input; await route.fallback(); });
  await page.goto('/bills'); await page.getByRole('button', { name: '筛选', exact: true }).click(); await page.getByLabel('包含隐藏账本').check(); await page.getByRole('button', { name: '应用筛选', exact: true }).click(); await page.getByRole('combobox', { name: '账本', exact: true }).click(); await page.getByRole('option', { name: '隐藏测试账本' }).click(); await expect.poll(() => last).toMatchObject({ includeHiddenBooks: true, bookIds: ['20'] });
});
