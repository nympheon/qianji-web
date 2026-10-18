import {parseWire} from '../../src/shared/wire-json';
import { expect,test } from '@playwright/test';
import { mockReadApp,ready,freshness } from './read-fixtures';
import {summarizeBill} from '../../src/features/ledger/model';
import {projectBill} from '../../src/features/sync/incremental';

test('matches the bill list when showing source currency and gross input on the overview',async({page})=>{
 await mockReadApp(page);const items=[
  {id:'101',assetid:20,money:14,remark:'外币资产换算'},
  {id:'102',assetid:20,money:12.6,remark:'外币优惠',extra:{transfee:-0.2}},
  {id:'103',assetid:-1,money:1.8,remark:'无关联资产外币',extra:{transfee:-0.2}},
 ].map(value=>summarizeBill(projectBill(parseWire(JSON.stringify({...value,bookid:10,type:0,time:1768881600,extra:{...value.extra,curr:{ss:'USD',sv:2,ts:'CNY',tv:12.6,bs:'CNY',bv:12.6}}})))));
 await page.route('**/api/actions',async route=>{if(route.request().postDataJSON().action==='ledger.list')return route.fulfill({json:ready({items,rows:items.map(bill=>({kind:'bill',bill})),nextCursor:null,freshness,incompleteReasons:[]},freshness)});await route.fallback();});
 await page.goto('/');for(const item of items){const row=page.locator('.recent-list > div').filter({hasText:item.remark});await expect(row).toContainText('原币录入 · USD');await expect(row).toContainText('$ 2.00');}
 await page.goto('/bills');await expect(page.locator('.bill-money:visible').filter({hasText:'$ 2.00'})).toHaveCount(3);
});
test('makes every implemented business area reachable from navigation',async({page})=>{
  await mockReadApp(page);await page.goto('/more');await expect(page.getByRole('heading',{name:'更多功能',exact:true})).toBeVisible();
  for(const name of ['资产','借贷','账本','分类','标签','预算','周期任务','分期','存钱计划','图片上传','报销','服务'])await expect(page.getByRole('main').getByRole('link',{name,exact:true})).toBeVisible();
  await page.getByRole('main').getByRole('link',{name:'分期',exact:true}).click();await expect(page.getByRole('heading',{name:'分期',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('offers year and custom date ranges plus asset and source filters without changing their meaning',async({page})=>{
  await mockReadApp(page);let input:unknown;await page.route('**/api/actions',async route=>{const body=route.request().postDataJSON();if(body.action==='ledger.list')input=body.input;await route.fallback();});
  await page.goto('/bills');await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByRole('combobox',{name:'日期范围',exact:true}).click();await page.getByRole('option',{name:'自选日期',exact:true}).click();await page.getByLabel('起始日期',{exact:true}).fill('2025-01-01');await page.getByLabel('结束日期',{exact:true}).fill('2026-01-20');await page.getByLabel('来源备注',{exact:true}).fill('微信');await page.getByRole('button',{name:'应用筛选',exact:true}).click();await expect.poll(()=>input).toMatchObject({date:{kind:'range',from:'2025-01-01',to:'2026-01-20'},sourceText:'微信'});
});
test('uses the same business filters in the calendar',async({page})=>{
  await mockReadApp(page);let input:unknown;await page.route('**/api/actions',async route=>{const body=route.request().postDataJSON();if(body.action==='ledger.calendar')input=body.input;await route.fallback();});await page.goto('/calendar');await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByLabel('来源备注',{exact:true}).fill('微信');await page.getByRole('button',{name:'应用筛选',exact:true}).click();await expect.poll(()=>input).toMatchObject({filter:{sourceText:'微信'}});
});

test('offers category hierarchy and book statistics using the appropriate names',async({page},testInfo)=>{
  await mockReadApp(page);let dimension='';await page.route('**/api/actions',async route=>{const{action,input}=route.request().postDataJSON();if(action==='ledger.statistics'){dimension=input.dimensions?.[0]??'';return route.fulfill({json:ready({currency:'CNY',range:null,totals:{},trend:[],comparison:null,incompleteReasons:[],freshness,groups:[{dimension,overlapping:false,items:[{key:dimension==='book'?'10':'50',parentId:null,totals:{totalSpend:'90',totalIncome:'0'}}]}]})});}await route.fallback();});
  await page.goto('/statistics');await page.getByRole('radio',{name:'分类层级',exact:true}).click();await expect.poll(()=>dimension).toBe('category-tree');await expect(page.getByRole('cell',{name:'餐饮',exact:true})).toBeVisible();await page.getByRole('radio',{name:'账本',exact:true}).click();await expect.poll(()=>dimension).toBe('book');await expect(page.getByRole('cell',{name:'日常账本',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(process.env.QIANJI_VISUAL_DIR)await page.screenshot({path:process.env.QIANJI_VISUAL_DIR+'/'+testInfo.project.name+'-stat-groups.png',fullPage:true});
});
test('lets an ordinary bill choose an asset and retain separate historical currency amounts',async({page})=>{
  await mockReadApp(page);let received:unknown;await page.route('**/api/actions',async route=>{const{action,input}=route.request().postDataJSON();if(action==='capabilities.list')return route.fulfill({json:ready([{action:'ledger.create',enabled:true}])});if(action==='ledger.transfer.options')return route.fulfill({json:ready({assets:[{id:'20',name:'人民币卡',currency:'CNY',type:1}],books:[],baseCurrency:'CNY',complete:true,freshness})});if(action==='ledger.draft.save')return route.fulfill({json:ready({draft:input.draft,operationId:null})});if(action==='ledger.create'){received=input;return route.fulfill({json:ready({id:'ordinary-fx',state:'succeeded',items:[],error:null})});}await route.fallback();});await page.goto('/bills');await page.getByRole('button',{name:'记一笔',exact:true}).click();await page.getByRole('combobox',{name:'记账关联资产',exact:true}).click();await page.getByRole('option',{name:'人民币卡 · CNY',exact:true}).click();await page.getByLabel('录入金额',{exact:true}).fill('100');await page.getByLabel('优惠（负数）',{exact:true}).fill('-10');await page.getByLabel('使用多币种',{exact:true}).check();await page.getByLabel('原币种',{exact:true}).fill('USD');await page.getByLabel('优惠后资产币种金额',{exact:true}).fill('630');await page.getByLabel('优惠后本位币金额',{exact:true}).fill('630');await page.getByRole('button',{name:'保存账单',exact:true}).click();await expect.poll(()=>received).toMatchObject({bills:[{assetId:'20',enteredMoney:'100',fee:'-10',currency:{srcSymbol:'USD',srcValue:'100',targetSymbol:'CNY',targetValue:'630',baseSymbol:'CNY',baseValue:'630'}}]});
});
