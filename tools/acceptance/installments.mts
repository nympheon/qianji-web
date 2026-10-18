import {DomainError} from '../../src/shared/errors';
import {compareMoney} from '../../src/shared/numbers';
import {installmentKey} from '../../src/features/installments/source';
import type {CaseEnvironment} from './cases.mts';
const oneId=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','新建资源缺少唯一回执ID');return ids[0]!;};
export async function runInstallments(e:CaseEnvironment){
 await e.synchronize();const types=await e.read('assets.types',{});await e.read('ledger.transfer.options',{},true);await e.read('categories.list',{bookId:e.known('book'),type:0});
 const card=types.items.find(type=>type.type===2);if(!card)throw new DomainError('ACCEPTANCE_TYPE_MISSING','缺少官方信用卡类型');
 if(!e.optional('installment-card'))e.remember('installment-card','asset',oneId(await e.write('installment-card-create','assets.submit',{mode:'create',fields:{name:e.prefix+'分期专用信用卡',type:card.type,subtype:card.subtype,currency:'CNY',money:'0',inCount:false,credit:{limit:'100',statementDay:1,paymentDay:10,statementIncludesPrevious:false}}})));
 const amounts={totalMoney:'3',totalFee:'0.3',totalCount:3,firstDate:'2026-12-31',time:'00:00',remainder:'first',feePlacement:'ave',zone:'Asia/Shanghai'} as const;
 const preview=await e.read('installments.preview',{...amounts,limit:120,assetId:e.known('installment-card')});if(preview.rows.map(row=>row.date).join(',')!=='2026-12-31,2027-01-31,2027-03-03'||compareMoney(preview.totals.money,'3.3'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分期跨月预览与原生 Calendar.set 向量不符');
 if(!e.optional('installment'))e.remember('installment','installment',oneId(await e.write('installment-create','installments.create',{...amounts,name:e.prefix+'测试三期分期',bookId:e.known('book'),assetId:e.known('installment-card'),categoryId:e.known('expense-category'),inCount:true,feeInCount:false,remark:e.prefix+'仅测试分期',tagIds:[e.known('tag')]})));
 const id=e.known('installment'),detail=async()=>{e.invalidateSource(installmentKey());const plan=(await e.read('installments.list',{sort:0,ascending:false})).items.find(plan=>plan.id===id);if(!plan)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试分期未回拉');return plan;};
 let plan=await detail();if(plan.totalCount!==3||compareMoney(plan.totalMoney,'3')||plan.count!==0||plan.bookId!==e.known('book'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','新建分期期数、起始进度或账本不一致');
 await e.write('installment-configure','installments.configure',{id,expectedVersion:plan.editVersion,inCount:false,feeInCount:true});plan=await detail();if(plan.inCount||!plan.feeInCount)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分期统计选项未回拉');
 const prepaid=await e.write('installment-prepay','installments.prepay',{id,expectedVersion:plan.prepayVersion,bookId:e.known('book'),fromAssetId:e.known('cash-a'),money:'3',fee:'0.05',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'测试提前还款'});
 await e.synchronize();for(const [key,billId]of Object.entries(prepaid.idMap))e.remember(key.includes(':expense:')?'installment-expense':'installment-repayment','bill',billId);
 plan=await detail();if(plan.status!==-1||!plan.prepaidAtSec||Object.keys(prepaid.idMap).length<2)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','提前结清状态或两类账单未分别证明');
 await e.write('installment-delete','installments.delete',{id,expectedVersion:plan.editVersion});e.invalidateSource(installmentKey());if((await e.read('installments.list',{sort:0,ascending:false})).items.some(plan=>plan.id===id))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分期删除未得到官方目录证明');
 return {state:'ready',nativeOverflowDatesCreateConfigurePrepayAndDelete:true,futureAutomaticExecutionNotTested:true};
}
