import { expect, test } from '@playwright/test';
import { detail, ledger, freshness, mockReadApp, ready } from './read-fixtures';
import { join } from 'node:path';

test('recovers the original submitted draft after reload and never suggests recreating an unknown write', async ({ page }, testInfo) => {
  await mockReadApp(page); let saved: unknown = null, sends = 0, originalKey = '';
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready(['ledger.create', 'ledger.edit', 'ledger.delete'].map((action) => ({ action, enabled: true, reason: null, kind: 'write', evidence: 'live-verified' }))) }); return; }
    if (action === 'ledger.draft.save') { saved = { draft: input.draft, operationId: null }; await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(saved) }); return; }
    if (action === 'ledger.create') {
      sends++; originalKey = input.requestId;
      saved = { draft: (saved as { draft: unknown }).draft, operationId: 'original-operation' };
      await route.abort('failed'); return;
    }
    if (action === 'operations.get' || action === 'operations.reconcile') { await route.fulfill({ json: { status: 'uncertain', data: { id: 'original-operation', action: 'ledger.create', state: 'uncertain', items: [], affectedIds: [], idMap: {}, error: null }, freshness: null, operationId: 'original-operation' } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('录入金额').fill('100'); await page.getByLabel('优惠（负数）').fill('-10'); await page.getByLabel('备注', { exact: true }).fill('网页草稿');
  await expect(page.getByText('草稿已保存')).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await expect(page.getByLabel('录入金额')).toHaveValue('100'); await expect(page.getByLabel('优惠（负数）')).toHaveValue('-10');
  await expect(page.getByLabel('备注', { exact: true })).toHaveValue('网页草稿');
  if (process.env.QIANJI_VISUAL_DIR) { await page.getByRole('dialog').evaluate((node) => { node.scrollTop = 0; }); await page.screenshot({ path: join(process.env.QIANJI_VISUAL_DIR, `${testInfo.project.name}-bill-editor.png`) }); }
  await page.getByRole('button', { name: '保存账单', exact: true }).click(); await expect(page.getByText('结果待核查', { exact: true })).toBeVisible();
  await expect(page.getByText('original-operation', { exact: true })).toBeVisible(); expect(originalKey).not.toBe('');
  await page.reload(); await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await expect(page.getByText('结果待核查', { exact: true })).toBeVisible(); await expect(page.getByText('original-operation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存账单', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '核查原操作', exact: true }).click(); expect(sends).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('uses edit versions and displays explicit failure without changing the long ID', async ({ page }) => {
  await mockReadApp(page); let edited: { bills: { id: string; expectedVersion: string }[] } | null = null;
  await page.route('**/api/actions', async (route) => {
    const { action, input } = route.request().postDataJSON();
    if (action === 'capabilities.list') { await route.fulfill({ json: ready([{ action: 'ledger.edit', enabled: true, reason: null, kind: 'write', evidence: 'live-verified' }]) }); return; }
    if (action === 'ledger.detail') { await route.fulfill({ json: ready({ ...detail, editVersion: 'a'.repeat(64) }, detail.freshness) }); return; }
    if (action === 'ledger.draft.get') { await route.fulfill({ json: ready(null) }); return; }
    if (action === 'ledger.draft.save') { await route.fulfill({ json: ready({ draft: input.draft, operationId: null }) }); return; }
    if (action === 'ledger.edit') { edited = input; await route.fulfill({ json: { status: 'error', data: { id: 'edit-operation', state: 'failed', items: [], error: { code: 'EXISTING_ID_REJECTED', message: '钱迹明确拒绝该 ID' } }, freshness: null, operationId: 'edit-operation', error: { code: 'EXISTING_ID_REJECTED', message: '钱迹明确拒绝该 ID' } } }); return; }
    await route.fallback();
  });
  await page.goto('/bills'); await page.getByRole('button', { name: /查看.*午餐/ }).first().click(); await page.getByRole('button', { name: '编辑账单', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('修改备注'); await page.getByRole('button', { name: '保存账单', exact: true }).click();
  await expect(page.getByText('钱迹明确拒绝该 ID').first()).toBeVisible();
  expect(edited).toMatchObject({ bills: [{ id: '1792000000123100000', expectedVersion: 'a'.repeat(64) }] });
});

test('refreshes late category options after first sync while preserving an already open empty draft',async({page})=>{
 await mockReadApp(page);let finished=false,optionsReads=0;
 await page.route('**/api/actions',async route=>{const {action,input}=route.request().postDataJSON();
  if(action==='capabilities.list'){await route.fulfill({json:ready([{action:'ledger.create',enabled:true,kind:'write'}])});return;}
  if(action==='ledger.options'){optionsReads++;await route.fulfill({json:ready({books:finished?[{id:'10',name:'同步账本',visible:true}]:[],categories:finished?[{id:'50',name:'同步分类',parentId:null}]:[],tags:[],complete:finished})});return;}
  if(action==='ledger.list'){await route.fulfill({json:finished?ready(ledger,freshness):{status:'running',data:{...ledger,items:[],rows:[]},freshness:{...freshness,complete:false},jobId:'first-sync'}});return;}
  if(action==='sync.status'){finished=true;await route.fulfill({json:ready({id:'first-sync',state:'succeeded'})});return;}
  if(action==='ledger.draft.save'){await route.fulfill({json:ready({draft:input.draft,operationId:null})});return;}
  await route.fallback();
 });
 await page.goto('/bills');await page.getByRole('button',{name:'记一笔',exact:true}).click();await page.getByLabel('录入金额').fill('12');
 await page.clock.runFor(2100);await expect(page.getByLabel('记账分类',{exact:true})).toContainText('同步分类');await expect(page.getByLabel('记账账本',{exact:true})).toContainText('同步账本');await expect(page.getByLabel('录入金额')).toHaveValue('12');expect(optionsReads).toBeGreaterThan(1);
});
