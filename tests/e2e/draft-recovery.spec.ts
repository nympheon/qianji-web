import { expect,test } from '@playwright/test';
import { mockReadApp,ready } from './read-fixtures';

test('does not replace an unread bill draft and restores its original request after retry',async({page})=>{
  await mockReadApp(page);let reads=0;const saves:Record<string,unknown>[]=[];
  await page.route('**/api/actions',async route=>{const{action,input}=route.request().postDataJSON();
    if(action==='capabilities.list')return route.fulfill({json:ready([{action:'ledger.create',enabled:true}])});
    if(action==='ledger.draft.get')return route.fulfill({json:++reads===1?{status:'error',data:null,freshness:null,error:{code:'UNAVAILABLE',message:'暂时无法读取原草稿'}}:ready({draft:{kind:'create',requestId:'original-unsubmitted',fields:{bookId:'10',type:0,enteredMoney:'123.45',fee:'0',categoryId:'50',timeSec:1768881600,remark:'保留的内容'}},operationId:null})});
    if(action==='ledger.draft.save'){saves.push(input.draft);return route.fulfill({json:ready({draft:input.draft,operationId:null})});}await route.fallback();
  });
  await page.goto('/bills');await page.getByRole('button',{name:'记一笔',exact:true}).click();await expect(page.getByRole('alert')).toContainText('暂时无法读取原草稿');await page.clock.runFor(1000);
  expect(saves).toEqual([]);await expect(page.getByRole('button',{name:'保存账单',exact:true})).toBeDisabled();await page.getByRole('button',{name:'重新读取草稿',exact:true}).click();await expect(page.getByLabel('录入金额',{exact:true})).toHaveValue('123.45');await expect(page.getByLabel('备注',{exact:true})).toHaveValue('保留的内容');await page.clock.runFor(500);await expect.poll(()=>saves.at(-1)).toMatchObject({requestId:'original-unsubmitted',fields:{enteredMoney:'123.45'}});
});

test('allows a failed initial attachment draft read to be retried without starting an upload',async({page})=>{
  await mockReadApp(page);let reads=0,uploads=0;await page.route('**/api/uploads',async route=>{uploads++;await route.abort();});
  await page.route('**/api/actions',async route=>{const{action}=route.request().postDataJSON();if(action==='attachments.draft.get')return route.fulfill({json:++reads===1?{status:'error',data:null,freshness:null,error:{code:'UNAVAILABLE',message:'图片草稿读取失败'}}:ready(null)});if(action==='capabilities.list')return route.fulfill({json:ready([{action:'attachments.upload',enabled:true}])});await route.fallback();});
  await page.goto('/attachments');await expect(page.getByRole('alert')).toContainText('图片草稿读取失败');await expect(page.getByLabel('添加图片',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'重新读取草稿',exact:true}).click();await expect(page.getByLabel('添加图片',{exact:true})).toBeEnabled();expect(uploads).toBe(0);
});
