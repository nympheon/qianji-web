import {DomainError} from '../../src/shared/errors';
import {compareMoney} from '../../src/shared/numbers';
import {assetInfoKey} from '../../src/features/assets/service';
import {bookListKey} from '../../src/features/books/source';
import {savingsKey} from '../../src/features/savings/source';
import type {CaseEnvironment} from './cases.mts';
const check=(value:unknown,message:string)=>{if(!value)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH',message);};
const one=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);check(ids.length===1,'新建测试资源缺少唯一ID');return ids[0]!;};
async function asset(e:CaseEnvironment,label:string){const id=e.known(label);e.invalidateSource(assetInfoKey(id));const row=(await e.read('assets.detail',{id},true)).asset;check(row,'测试资产缺失');return row!;}
async function saving(e:CaseEnvironment,label:string){e.invalidateSource(savingsKey);const row=(await e.read('savings.list',{},true)).items.find(item=>item.planId===e.known(label));check(row?.fields,'测试存钱计划配置不完整');return row!;}
async function book(e:CaseEnvironment,label:string){e.invalidateSource(bookListKey);const row=(await e.read('books.list',{includeHidden:true})).items.find(item=>item.id===e.known(label));check(row,'测试账本缺失');return row!;}
export async function runAssetTypesAndBalance(e:CaseEnvironment){
 await e.synchronize();const types=await e.read('assets.types',{});
 for(const type of [3,4] as const){const def=types.items.find(item=>item.type===type);check(def,'官方未提供类型'+type);const label='asset-kind-'+type;
  await e.phase(label+'-create',async()=>{e.remember(label,'asset',one(await e.write(label+'-create','assets.submit',{mode:'create',fields:{name:e.prefix+label,type,subtype:def!.subtype,currency:'CNY',money:'0',inCount:false}})));check((await asset(e,label)).type===type,'资产类型未回拉');});
  await e.phase(label+'-metadata',async()=>{const row=await asset(e,label);await e.write(label+'-metadata','assets.submit',{mode:'edit',id:row.id,expectedVersion:row.editVersion,changes:{name:e.prefix+label+'已改',remark:e.prefix+'资料已改',inCount:false,color:'3792FA',icon:def!.icon}});check((await asset(e,label)).name===e.prefix+label+'已改','资产资料未回拉');});
  await e.phase(label+'-delete',async()=>{const row=await asset(e,label);await e.write(label+'-delete','assets.delete',{id:row.id,expectedVersion:row.editVersion});});
 }
 const label='asset-foreign-negative',cash=types.items.find(item=>item.type===1);check(cash,'缺少现金类型');
 await e.phase(label+'-create',async()=>{e.remember(label,'asset',one(await e.write(label+'-create','assets.submit',{mode:'create',fields:{name:e.prefix+label,type:1,subtype:cash!.subtype,currency:'USD',money:'0',inCount:false}})));});
 for(const [step,money,recordDifference]of [['negative','-1',false],['expense','-2',true],['income','-1',true]] as const)await e.phase(label+'-'+step,async()=>{
  const row=await asset(e,label),op=await e.write(label+'-'+step,'assets.adjustBalance',{id:row.id,expectedVersion:row.editVersion,money,recordDifference,...(recordDifference?{difference:{categoryId:e.known(step==='expense'?'expense-category':'income-category'),countInBudget:false,countInStatistics:false,remark:e.prefix+label+step,images:[e.known('image-bill')]}}:{})});await e.synchronize();check(compareMoney((await asset(e,label)).money,money)===0,'负余额或外币差额未更新');
  if(recordDifference){const ids=op.affectedIds.filter(id=>/^[1-9]\d+$/.test(id));check(ids.length===1,'差额缺少唯一官方账单');e.remember(label+'-'+step,'bill',ids[0]!);const bill=await e.read('ledger.detail',{id:ids[0]!});check(bill.type===(step==='expense'?0:1)&&bill.bookId===e.known('book')&&bill.flags===3&&bill.images.includes(e.known('image-bill')),'外币差额账单类型、账本、图片或排除标记不符');}
 });
 await e.phase(label+'-cleanup',async()=>{for(const step of ['expense','income']){const row=await e.read('ledger.detail',{id:e.known(label+'-'+step)});await e.write(label+'-'+step+'-delete','ledger.delete',{bills:[{id:row.id,expectedVersion:row.editVersion}]});}await e.synchronize();const row=await asset(e,label);await e.write(label+'-delete','assets.delete',{id:row.id,expectedVersion:row.editVersion});});
 return {state:'ready',assetTypesThreeFourMetadataForeignNegativeBalanceAndBothDifferenceDirections:true};
}
export async function runCreditMetadata(e:CaseEnvironment){
 const def=(await e.read('assets.types',{})).items.find(item=>item.type===2);check(def,'缺少信用卡类型');
 for(const suffix of ['a','b']){const label='credit-metadata-'+suffix;await e.phase(label+'-create',async()=>{e.remember(label,'asset',one(await e.write(label+'-create','assets.submit',{mode:'create',fields:{name:e.prefix+label,type:2,subtype:def!.subtype,currency:'CNY',money:'0',inCount:false,credit:{limit:'100',statementDay:1,paymentDay:10,statementIncludesPrevious:false}}})));});}
 const label='credit-metadata-b';for(const shared of [true,false])await e.phase(label+'-'+shared,async()=>{const row=await asset(e,label);await e.write(label+'-'+shared,'assets.submit',{mode:'edit',id:row.id,expectedVersion:row.editVersion,changes:{credit:{limit:'200',statementDay:2,paymentDay:12,statementIncludesPrevious:true,sharedLimitAssetId:shared?e.known('credit-metadata-a'):null}}});const after=await asset(e,label);check(after.credit?.statementDay===2&&after.credit?.paymentRule==='12'&&compareMoney(after.credit.limit,'200')===0&&after.credit.statementIncludesPrevious&&after.credit.sharedLimitAssetId===(shared?e.known('credit-metadata-a'):null),'信用卡账期、额度、共享额度未回拉');});
 for(const alias of [label,'credit-metadata-a'])await e.phase(alias+'-delete',async()=>{const row=await asset(e,alias);await e.write(alias+'-delete','assets.delete',{id:row.id,expectedVersion:row.editVersion});});return {state:'ready',creditDatesLimitSharedLimitSetAndClear:true};
}
export async function runBookTemplates(e:CaseEnvironment){
 await e.phase('book-long-name-cleanup',async()=>{const op=await e.write('book-template--1-create','books.submit',{},['BOOK_NAME_TRUNCATED']);e.remember('book-long-name','book',one(op));const row=await book(e,'book-long-name');await e.write('book-long-name-delete','books.delete',{id:row.id,expectedVersion:row.editVersion});});
 const types=await e.read('books.types',{});for(const type of types.items){const label='book-native-template-'+type.type;
  await e.phase(label+'-create',async()=>{e.remember(label,'book',one(await e.write(label+'-create','books.submit',{mode:'create',type:type.type,name:e.prefix+'模板'+type.type})));check((await book(e,label)).type===type.type,'账本模板类型未回拉');});
  await e.phase(label+'-delete',async()=>{const row=await book(e,label);await e.write(label+'-delete','books.delete',{id:row.id,expectedVersion:row.editVersion});});
 }return {state:'ready',officialTemplateTypes:types.items.map(item=>item.type)};
}
export async function runBookRanges(e:CaseEnvironment){
 const label='book-ranges';await e.phase(label+'-create',async()=>{e.remember(label,'book',one(await e.write(label+'-create','books.submit',{mode:'create',type:-1,name:e.prefix+'周期测试',range:'q'})));check((await book(e,label)).range==='q','新建季度账本未回拉');});
 for(const range of ['y','all','m28',''] as const)await e.phase(label+'-'+range,async()=>{const row=await book(e,label);await e.write(label+'-'+range,'books.configure',{id:row.id,expectedVersion:row.editVersion,range});check((await book(e,label)).range===range,'账本周期未回拉');});
 await e.phase(label+'-delete',async()=>{const row=await book(e,label);await e.write(label+'-delete','books.delete',{id:row.id,expectedVersion:row.editVersion});});return {state:'ready',quarterYearAllMonth28AndNaturalMonth:true};
}
export async function runSavingsMetadata(e:CaseEnvironment){
 const label='savings-metadata',dates={startDate:'2026-12-31',time:'12:30',zone:'Asia/Shanghai'};
 await e.phase(label+'-create',async()=>{e.remember(label,'saving',one(await e.write(label+'-create','savings.submit',{mode:'create',fields:{name:e.prefix+label,currency:'CNY',rule:{...dates,mode:'custom',total:'10',endDate:null}}})));});
 await e.phase(label+'-edit',async()=>{const row=await saving(e,label);await e.write(label+'-edit','savings.submit',{mode:'edit',planId:row.planId,expectedVersion:row.editVersion,changes:{name:e.prefix+label+'已改',currency:'USD',rule:{...dates,mode:'custom',total:'20',endDate:'2027-12-31'},remark:e.prefix+'配置已改',icon:row.fields!.icon,color:'12ABEF'}});const after=await saving(e,label);check(after.name===e.prefix+label+'已改'&&after.currency==='USD'&&after.fields?.color==='12ABEF'&&after.fields.rule.mode==='custom'&&compareMoney(after.fields.rule.total,'20')===0,'存钱名称、无历史币种、目标、颜色或日期未回拉');});
 await e.phase(label+'-delete',async()=>{await e.write(label+'-delete','savings.delete',{planId:e.known(label),deleteBills:false});e.invalidateSource(savingsKey);check(!(await e.read('savings.list',{},true)).items.some(row=>row.planId===e.known(label)),'测试存钱配置删除未回拉');});return {state:'ready',savingsNameEmptyHistoryCurrencyRuleDateColorRemarkEdit:true};
}
