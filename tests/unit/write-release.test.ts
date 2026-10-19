import {expect,it} from 'vitest';
import {writeReleaseProblem,liveWriteScopes} from '../../src/app/write-release';
import {actionDefinitions} from '../../src/contracts/actions';
import {isPublicAction,excludedActions} from '../../src/contracts/scope';
it('uniformly releases every provided write after native acceptance and leaves excluded actions unavailable',()=>{
 const provided=Object.entries(actionDefinitions).filter(([name,value])=>isPublicAction(name)&&value.kind==='write');
 expect(Object.keys(liveWriteScopes).sort()).toEqual(provided.map(([name])=>name).sort());
 for(const [name,definition] of provided){expect(definition.evidence,name).toBe('live-verified');expect(definition.unavailable,name).toBeUndefined();expect(writeReleaseProblem(name,{}),name).toBeNull();}
 for(const action of excludedActions)expect(writeReleaseProblem(action,{})?.code,action).toBe('WRITE_LIVE_UNVERIFIED');
 expect(writeReleaseProblem('future.unverifiedWrite',{})?.code).toBe('WRITE_LIVE_UNVERIFIED');
});
it('passes verified extended scenarios to their domain validation instead of obsolete acceptance gates',()=>{
 for(const [name,input] of [
 ['books.submit',{mode:'create',type:1,range:'q'}],['assets.submit',{mode:'create',fields:{type:4,subtype:41,currency:'CNY'}}],
 ['assets.submit',{mode:'edit',changes:{credit:{}}}],['assets.groups.submit',{id:'1',name:'test'}],
 ['categories.submitMany',{type:1,parentId:'1'}],['tags.submitTag',{mode:'edit',groupId:null}],
 ['ledger.transfer',{mode:'create',currency:{srcSymbol:'USD'}}],['ledger.reimburse',{assetId:null,currency:{srcSymbol:'USD'}}],
 ['debt.pay',{principal:'0',interest:'1'}],['debt.create',{images:['uploaded']}],
 ['budget.submit',{range:'m15',changes:[{categoryId:null,limit:'0'},{categoryId:'2',limit:'7'}]}],
 ['repeat.submit',{mode:'edit',changes:{enteredMoney:'1'}}],['installments.create',{remainder:'intl',feePlacement:'last'}],
 ['installments.prepay',{spendCurrency:{srcSymbol:'USD'},transferCurrency:{srcSymbol:'CNY'},images:['uploaded']}],
 ['savings.submit',{mode:'edit',changes:{name:'test',color:'3792FA'}}],
 ['repeat.setBillBinding',{}],['installments.setBillBinding',{}],['ledger.setReimbursable',{}],['debt.editPrincipal',{}],
 ] as const)expect(writeReleaseProblem(name,input),name).toBeNull();
});
