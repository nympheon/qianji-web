import { expect,it } from 'vitest';
import { createTestApp } from '../support/app';
import { createUpstream,TestClock } from '../support/upstream';
import { Coordinator } from '../../src/actor/coordinator';
import { AccountingConfiguration,createAccountingConfigurationHandler } from '../../src/features/books/accounting';
import type { MutationHandler } from '../../src/operations/contract';
it('keeps the original currency context across autosaves and rejects its old financial request before send',async()=>{
  const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);let sends=0;
  await app.repository(async repository=>{repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();const config=new AccountingConfiguration({repository,clock});config.applyOfficial(app.scope,{basecur:'CNY'});repository.saveDraft(app.scope,'bill:new',{requestId:'old-context',fields:{enteredMoney:'100'}});config.applyOfficial(app.scope,{basecur:'USD'});repository.saveDraft(app.scope,'bill:new',{requestId:'old-context',fields:{enteredMoney:'200'}});
    const handler:MutationHandler={prepare:async()=>({payload:{},items:[{id:'bill',affectedIds:['bill']}],affectedIds:['bill']}),send:async()=>{sends++;return{ec:'200',httpStatus:200,data:null};},applyReceipt:()=>({items:[{id:'bill',state:'succeeded'}]}),reconcile:async()=>({items:[]})},c=new Coordinator({repository,clock,client:upstream.client},new Map([['ledger.create',handler]]));
    const old=await c.submit({action:'ledger.create',scope:app.scope,requestId:'old-context',input:{}});expect(old.error?.code).toBe('DRAFT_CURRENCY_CHANGED');expect(sends).toBe(0);
    repository.saveDraft(app.scope,'bill:new',{requestId:'reviewed-new-context',fields:{enteredMoney:'200'}});expect((await c.submit({action:'ledger.create',scope:app.scope,requestId:'reviewed-new-context',input:{}})).state).toBe('succeeded');expect(sends).toBe(1);
  });
});
it('does not change the global base currency while a financial operation is still unresolved',async()=>{
  const app=await createTestApp(),clock=new TestClock(),upstream=createUpstream(clock,app.scope);
  await app.repository(async repository=>{repository.sql.exec("UPDATE connection SET state='connected' WHERE singleton=1").toArray();const config=new AccountingConfiguration({repository,clock});config.applyOfficial(app.scope,{basecur:'CNY'});const c=new Coordinator({repository,clock,client:upstream.client},new Map([['books.setBaseCurrency',createAccountingConfigurationHandler({configuration:config})]]));c.store.create({action:'installments.prepay',requestId:'pending-finance',scope:app.scope,input:{}},'fixture-pending');const result=await c.submit({action:'books.setBaseCurrency',requestId:'change-base',scope:app.scope,input:{baseCurrency:'USD',expectedVersion:config.read(app.scope).editVersion}});expect(result.error?.code).toBe('PENDING_FINANCIAL_OPERATIONS');expect(upstream.calls).toHaveLength(0);});
});
