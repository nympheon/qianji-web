import { expect, test } from '@playwright/test';
import { detail, freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';
const assets = [{ id: '1', name: '现金', type: 0, currency: 'CNY', money: '1000', lastPayTimeSec: '0' }, { id: '2', name: '信用卡', type: 2, currency: 'CNY', money: '-200', lastPayTimeSec: '0' }, { id: '3', name: '美元账户', type: 0, currency: 'USD', money: '500', lastPayTimeSec: '0' }];

test('offers only credit cards as repayment targets',async({page})=>{
 await mockReadApp(page);await page.route('**/api/actions',async route=>{const {action}=route.request().postDataJSON();if(action==='capabilities.list')return route.fulfill({json:ready([{action:'ledger.repayCard',enabled:true}])});if(action==='ledger.transfer.options')return route.fulfill({json:ready({assets,books:[{id:'10',name:'日常账本'}],baseCurrency:'CNY',complete:true,freshness})});await route.fallback();});
 await page.goto('/bills');await page.getByRole('button',{name:'信用卡还款',exact:true}).click();await page.getByRole('combobox',{name:'转入资产',exact:true}).click();await expect(page.getByRole('option')).toHaveCount(1);await expect(page.getByRole('option',{name:'信用卡 · CNY',exact:true})).toBeVisible();
});

test('previews both sides of a transfer and preserves the original operation after an unknown result', async ({ page }, testInfo) => {
  await mockReadApp(page); let draft: unknown = null, sent = 0;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.transfer', enabled: true, reason: null }]) }); return; }
    if (action === 'ledger.transfer.options') { await route.fulfill({ json: ready({ assets, books: [{ id: '10', name: '日常账本' }], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(draft) }); return; }
    if (action === 'ledger.draft.save') { draft = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(draft) }); return; }
    if (action === 'ledger.transfer.preview') { expect(input.input).toMatchObject({ enteredMoney: '103', fee: '3', fromAssetId: '1', targetAssetId: '2' }); await route.fulfill({ json: ready({ principal: '100', fee: '3', fromAmount: '103', targetAmount: '100', currency: null, from: assets[0], target: assets[1], effects: [], complete: true, stale: false, freshness }, freshness) }); return; }
    if (action === 'ledger.transfer') { sent++; draft = { ...(draft as object), operationId: 'transfer-original' }; await route.fulfill({ json: { status: 'uncertain', data: { id: 'transfer-original', state: 'uncertain', action, items: [], affectedIds: [], idMap: {}, error: null }, freshness: null, operationId: 'transfer-original' } }); return; }
    if (action === 'operations.get') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'transfer-original', state: 'uncertain', items: [], error: null }, freshness: null } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: '转账', exact: true }).click();
  await page.getByLabel('录入金额').fill('103'); await page.getByLabel('手续费 / 优惠').fill('3');
  await page.getByRole('button', { name: '预览金额', exact: true }).click();
  await expect(page.getByTestId('transfer-principal')).toContainText('100.00'); await expect(page.getByTestId('transfer-from')).toContainText('103.00'); await expect(page.getByTestId('transfer-target')).toContainText('100.00');
  if (process.env.QIANJI_VISUAL_DIR) { await page.getByRole('dialog').evaluate((node) => { node.scrollTop = 0; }); await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-transfer-editor.png`) }); }
  await page.getByRole('button', { name: '保存转账', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: '转账', exact: true }).click(); await expect(page.getByText('transfer-original', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '保存转账', exact: true })).toBeDisabled(); expect(sent).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('collects explicit historical amounts for a cross-currency credit repayment', async ({ page }) => {
  await mockReadApp(page); let savedInput: unknown = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.repayCard', enabled: true, reason: null }]) }); return; }
    if (action === 'ledger.transfer.options') { await route.fulfill({ json: ready({ assets: [assets[2], assets[1]], books: [{ id: '10', name: '日常账本' }], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'ledger.draft.save') { await route.fulfill({ json: ready({ draft: input.draft, operationId: null }) }); return; }
    if (action === 'ledger.repayCard') { savedInput = input; await route.fulfill({ json: { status: 'ready', data: { id: 'card-original', state: 'succeeded', action, items: [], error: null }, freshness: null, operationId: 'card-original' } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: '信用卡还款', exact: true }).click();
  await page.getByLabel('录入金额').fill('103'); await page.getByLabel('手续费 / 优惠').fill('3'); await page.getByLabel('历史转入金额（CNY）').fill('720'); await page.getByLabel('历史本位币金额（CNY）').fill('741.6');
  await page.getByRole('button', { name: '保存还款', exact: true }).click(); await expect(page.getByText('操作已完成', { exact: true })).toBeVisible();
  expect(savedInput).toMatchObject({ mode: 'create', fromAssetId: '3', targetAssetId: '2', enteredMoney: '103', fee: '3', currency: { srcSymbol: 'USD', srcValue: '103', targetSymbol: 'CNY', targetValue: '720', baseSymbol: 'CNY', baseValue: '741.6' } });
  await page.getByRole('button', { name: '建立新草稿', exact: true }).click(); await expect(page.getByLabel('录入金额')).toHaveValue(''); await expect(page.getByRole('button', { name: '保存还款', exact: true })).toBeEnabled();
});

test('edits a transfer through its dedicated action and sends only changed fields', async ({ page }) => {
  await mockReadApp(page); let edited: unknown = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.transfer', enabled: true, reason: null }]) }); return; }
    if (action === 'ledger.transfer.options') { await route.fulfill({ json: ready({ assets, books: [{ id: '10', name: '日常账本' }], baseCurrency: 'CNY', complete: true, freshness }) }); return; }
    if (action === 'ledger.detail') { await route.fulfill({ json: ready({ ...detail, type: 2, money: '100', transferFee: '3', fromId: '1', targetId: '2', editVersion: 'b'.repeat(64) }, freshness) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'ledger.draft.save') { await route.fulfill({ json: ready({ draft: input.draft, operationId: null }) }); return; }
    if (action === 'ledger.transfer') { edited = input; await route.fulfill({ json: { status: 'ready', data: { id: 'edit-transfer', state: 'succeeded', action, items: [], error: null }, freshness: null, operationId: 'edit-transfer' } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: /查看.*午餐/ }).first().click(); await page.getByRole('button', { name: '编辑账单', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('转账备注'); await page.getByRole('button', { name: '保存转账', exact: true }).click(); await expect(page.getByText('操作已完成', { exact: true })).toBeVisible();
  expect(edited).toMatchObject({ mode: 'edit', id: '1792000000123100000', expectedVersion: 'b'.repeat(64), changes: { remark: '转账备注' } });
  expect((edited as { changes: unknown }).changes).toEqual({ remark: '转账备注' });
});
