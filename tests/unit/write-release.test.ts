import {expect,it} from 'vitest';
import {writeReleaseProblem,liveWriteScopes} from '../../src/app/write-release';
it('releases only actual verified scenarios and retains concrete gaps',()=>{
 expect(writeReleaseProblem('books.submit',{mode:'create',type:-1})).toBeNull();
 expect(writeReleaseProblem('books.submit',{mode:'create',type:1})?.code).toBe('WRITE_LIVE_UNVERIFIED');
 expect(writeReleaseProblem('assets.submit',{mode:'create',fields:{type:1,subtype:11,currency:'CNY'}})).toBeNull();
 expect(writeReleaseProblem('assets.submit',{mode:'create',fields:{type:4,subtype:41,currency:'CNY'}})?.code).toBe('WRITE_LIVE_UNVERIFIED');
 expect(writeReleaseProblem('ledger.transfer',{mode:'create',currency:{srcSymbol:'USD'}})?.code).toBe('WRITE_LIVE_UNVERIFIED');
 expect(writeReleaseProblem('budget.submit',{range:'',changes:[{categoryId:null,limit:'0'}]})?.code).toBe('BUDGET_TOTAL_CANCEL_UNVERIFIED');
 expect(writeReleaseProblem('books.setBaseCurrency',{})?.code).toBe('WRITE_LIVE_UNVERIFIED');
 expect(writeReleaseProblem('installments.setBillBinding',{})?.code).toBe('WRITE_LIVE_UNVERIFIED');
 expect(liveWriteScopes['attachments.upload']).toContain('账单');
});
