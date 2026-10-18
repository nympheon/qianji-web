import {DomainError} from '../../src/shared/errors';
import {createdBill} from './ledger.mts';
import type {CaseEnvironment} from './cases.mts';
async function rejected(e:CaseEnvironment,step:string,action:'ledger.edit'|'ledger.delete',input:Record<string,unknown>,code:string){try{await e.write(step,action,input);}catch(error){if(error instanceof DomainError&&error.code===code)return;throw error;}throw new DomainError('ACCEPTANCE_GUARD_FAILED','预期冲突操作未被拒绝');}
export async function runConflicts(e:CaseEnvironment){
 await e.synchronize();await e.read('ledger.transfer.options',{},true);
 if(!e.optional('conflict-bill')){const op=await e.write('conflict-create','ledger.create',{bills:[{bookId:e.known('book'),type:1,categoryId:e.known('income-category'),assetId:null,enteredMoney:'0.11',fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'冲突收入'}]});e.remember('conflict-bill','bill',createdBill(op));}
 await e.synchronize();const id=e.known('conflict-bill'),original=await e.read('ledger.detail',{id});
 await e.write('conflict-edit-a','ledger.edit',{bills:[{id,expectedVersion:original.editVersion,changes:{enteredMoney:'0.22',remark:e.prefix+'先到的编辑',countInStatistics:false,countInBudget:false}}]});await e.synchronize();
 await rejected(e,'conflict-edit-b-stale','ledger.edit',{bills:[{id,expectedVersion:original.editVersion,changes:{remark:e.prefix+'过期的第二端编辑'}}]},'DRAFT_SOURCE_CHANGED');
 await rejected(e,'conflict-delete-stale','ledger.delete',{bills:[{id,expectedVersion:original.editVersion}]},'DRAFT_SOURCE_CHANGED');
 const current=await e.read('ledger.detail',{id});if(current.money!=='0.22'||current.remark!==e.prefix+'先到的编辑'||current.flags!==3)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','过期编辑覆盖了较新数据');
 await e.write('conflict-delete-current','ledger.delete',{bills:[{id,expectedVersion:current.editVersion}]});await e.synchronize();if((await e.read('ledger.list',{bookIds:[e.known('book')],limit:200})).items.some(bill=>bill.id===id))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','真实删除后账单仍存在');
 await rejected(e,'conflict-edit-deleted','ledger.edit',{bills:[{id,expectedVersion:current.editVersion,changes:{remark:e.prefix+'删后过期编辑'}}]},'BILL_NOT_LOADED');
 return {state:'ready',staleEditDeleteAndEditAfterDeleteRejected:true,serverAtomicCompareAndSwapNotClaimed:true};
}
export async function runReceiptLoss(e:CaseEnvironment,recoverOnly=false){
 await e.synchronize();const before=e.billPostCount();if(!recoverOnly)e.armReceiptLoss();
 const input={bills:[{bookId:e.known('book'),type:0,categoryId:e.known('expense-category'),assetId:null,enteredMoney:'0.03',fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'成功响应丢失'}]};
 const op=await e.write('receipt-loss-create','ledger.create',input);e.remember('receipt-loss-bill','bill',createdBill(op));
 const repeated=await e.write('receipt-loss-create','ledger.create',input);if(repeated.id!==op.id||e.billPostCount()-before!==(recoverOnly?0:1))throw new DomainError('ACCEPTANCE_DUPLICATE_SEND','响应丢失后没有复用原操作或发生重复发送');
 if((await e.read('ledger.detail',{id:e.known('receipt-loss-bill')})).remark!==e.prefix+'成功响应丢失')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','响应丢失后未按原账单ID查回');
 return {state:'ready',actualServerAcceptedResponseDroppedThenReadOnlyReconciled:true,writePosts:recoverOnly?0:1};
}
