import { exports,env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { Repository } from '../../src/storage/database';
async function rpc(method:string,params:object={}){const response=await exports.default.fetch('https://example.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const text=await response.text(),body=response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').filter(line=>line.startsWith('data:')).at(-1)!.slice(5):text;return JSON.parse(body);}
it('exposes business workflows with typed identities and hides Web draft bookkeeping',async()=>{
  const result=await rpc('tools/list'),tools=result.result.tools as {name:string;inputSchema:{properties?:Record<string,unknown>};annotations:{readOnlyHint:boolean;destructiveHint:boolean}}[];
  const required=['ledger.list','ledger.calendar','ledger.statistics','ledger.create','ledger.transfer','ledger.repayCard','ledger.refund','ledger.reimburse','ledger.cancelReimbursement','assets.list','assets.adjustBalance','assets.groups.submit','debt.pay','categories.move','tags.setArchived','budget.submit','repeat.setPaused','installments.prepay','savings.deposit','savings.cancelDeposit','attachments.upload','sync.start','connection.check'];
  for(const name of required)expect(tools.find(tool=>tool.name===name),name).toBeDefined();
  expect(tools.some(tool=>tool.name.includes('.draft.'))).toBe(false);
  for(const name of ['books.setBaseCurrency','books.quit','books.members','books.reorder','assets.reorder','assets.groups.reorder','tags.reorderGroups','savings.reorder'])expect(tools.some(tool=>tool.name===name)).toBe(false);
  expect(tools.find(tool=>tool.name==='savings.deposit')?.inputSchema.properties).toMatchObject({planId:{type:'string'},amount:{type:'string'},requestId:{type:'string'}});
  expect(tools.find(tool=>tool.name==='savings.cancelDeposit')?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true});
  expect(tools.find(tool=>tool.name==='installments.configure')?.inputSchema.properties).not.toHaveProperty('totalMoney');
});
it('returns usable absolute media and upload links to a remote MCP client',async()=>{
  await runInDurableObject(env.QIANJI_STATE.getByName('personal'),(_actor,state)=>{const repo=new Repository(state.storage);repo.bindScope({uid:crypto.randomUUID(),connectionEpoch:crypto.randomUUID()});repo.sql.exec("UPDATE connection SET state='disconnected',token_cipher=NULL WHERE singleton=1").toArray();});
  const options=await rpc('tools/call',{name:'attachments.options',arguments:{}});expect(options.result.structuredContent.data.uploadPage).toBe('https://example.test/attachments');
  const image=await rpc('tools/call',{name:'attachments.resolve',arguments:{reference:'headimages/_fixture_key',purpose:'cover',size:'small'}});expect(image.result.structuredContent.data.url).toMatch(/^https:\/\/example\.test\/api\/images\?/);
});
