import {isLosslessNumber} from 'lossless-json';
import {DomainError} from '../shared/errors';
import {asBillObject,billExtra,numericText,positiveBillId} from '../shared/bill-wire';
import {compareMoney} from '../shared/numbers';
import type {Problem} from '../shared/reply';
import type {MutationCommand,PreparedMutation} from '../operations/contract';
import type {Repository} from '../storage/database';

/** Actual upstream receipts and independent reads, 2026-10-19; see docs/acceptance/live-matrix.md. */
export const liveWriteScopes:Readonly<Record<string,string>>={
 'ledger.create':'普通收支和待报销；支出含已核对历史外币、优惠、标签和图片',
 'ledger.edit':'普通账单金额、优惠、资产、日期、分类、备注、标记、标签、图片',
 'ledger.delete':'普通收支和退款子记录；其他类型删除待专项核验',
 'ledger.transfer':'本位币转账新增、编辑、删除；手续费及优惠',
 'ledger.repayCard':'本位币信用卡还款新增、编辑、删除；手续费及优惠',
 'ledger.refund':'本位币部分退款新增、金额与资产编辑',
 'ledger.reimburse':'本位币多源组合报销，指定实际到账资产',
 'ledger.cancelReimbursement':'已完整载入的新式报销源关系及余额回退',
 'assets.submit':'现金类型11（CNY/USD）和CNY信用卡；现有已核验类型的资料编辑',
 'assets.adjustBalance':'CNY现金余额；可选测试过的差额收支标记',
 'assets.setVisible':'正常普通资产隐藏与恢复',
 'assets.setFinished':'借入和借出结清、恢复未结清',
 'assets.delete':'没有任何关联账单和计划的空资产',
 'assets.groups.submit':'新建分组',
 'assets.groups.add':'资产加入已载入分组',
 'assets.groups.remove':'资产移出分组',
 'assets.groups.delete':'删除空分组',
 'debt.create':'本位币借入、借出，初始本金采用官方账单',
 'debt.appendPrincipal':'借入、借出追加本金',
 'debt.pay':'正数本金和利息分别生成原生记录',
 'books.submit':'日常类型-1新建；名称、封面编辑',
 'books.configure':'自然月和自定义月起始日',
 'books.setVisible':'账本隐藏和恢复',
 'books.delete':'无账单的空账本',
 'categories.submit':'支出分类一二级新建、名称与图标编辑',
 'categories.submitMany':'支出一级分类，官方图标批量新增',
 'categories.changeLevel':'支出分类升级和降级',
 'categories.move':'支出二级分类移动',
 'categories.reorder':'同账本完整支出分类排序',
 'categories.delete':'没有关联账单的空分类',
 'tags.submitGroup':'新建标签分组',
 'tags.submitTag':'新建有明确分组的标签',
 'tags.setArchived':'标签归档和恢复',
 'tags.reorderTags':'同组标签排序',
 'tags.deleteTag':'没有关联账单的标签',
 'tags.deleteGroup':'空标签组删除',
 'budget.submit':'自然月/年度正数总预算、一级分类预算；分类设0取消，完整集合保留其他项',
 'attachments.upload':'JPEG账单和封面、PNG分类图标；官方对象key/hash及实际业务关联',
 'repeat.submit':'本位币普通支出月规则新建、备注编辑；不承诺手机离线执行',
 'repeat.setPaused':'周期任务明确暂停和恢复目标，只读核对',
 'repeat.delete':'删除周期管理对象，保留历史账单',
 'installments.create':'本位币未来分期、first尾差和ave费用',
 'installments.configure':'两项统计配置',
 'installments.prepay':'本位币无图片提前还款；管理对象、支出、还款分别确认',
 'installments.delete':'删除分期管理对象',
 'savings.submit':'七种规则新建、备注编辑；新建可采用官方默认图标',
 'savings.deposit':'仅进度存入、CNY及CNY→USD关联转账',
 'savings.cancelDeposit':'撤销进度或关联转账存入',
 'savings.delete':'明确保留或删除关联账单',
};
const obj=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function inputValue(value:unknown):unknown{if(isLosslessNumber(value)){const number=Number(value.value);if(!Number.isSafeInteger(number))throw new DomainError('INVALID_ACTION_INPUT','数值参数无法核对');return number;}if(Array.isArray(value))return value.map(inputValue);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,inputValue(child)]));return value;}
const gap=(message:string,code='WRITE_LIVE_UNVERIFIED'):Problem=>({code,message});
export function writeReleaseProblem(action:string,input:unknown):Problem|null{
 if(!liveWriteScopes[action])return gap('此写入尚未通过专用资源真实验收');
 const p=obj(inputValue(input)),fields=obj(p.fields),changes=obj(p.changes);
 if(action==='books.submit'&&(p.mode==='create'&&p.type!==-1||p.range!==undefined))return gap('当前仅放行日常账本新建；周期修改请用专用操作');
 if(action==='assets.submit'&&p.mode==='create'&&!(fields.type===1&&fields.subtype===11&&['CNY','USD'].includes(String(fields.currency))||fields.type===2&&fields.currency==='CNY'))return gap('此资产类型或币种组合尚未真实核验');
 if(action==='assets.submit'&&p.mode==='edit'&&changes.credit!==undefined)return gap('现有信用卡配置编辑尚未专项核验');
 if(action==='assets.groups.submit'&&p.id!==null)return gap('资产分组改名尚未真实核验');
 if(action.startsWith('categories.')&&(p.type!==0||action==='categories.submitMany'&&p.parentId!=null))return gap('此分类收支类型或批量层级尚未真实核验');
 if(['tags.submitTag','tags.submitGroup'].includes(action)&&p.mode!=='create')return gap('标签或分组编辑尚未真实核验');
 if(action==='tags.submitTag'&&p.groupId==null)return gap('无分组标签创建尚未真实核验');
 if(['ledger.transfer','ledger.repayCard','ledger.refund','ledger.reimburse'].includes(action)&&(p.currency!=null||changes.currency!=null))return gap('此关联写入的外币组合尚未真实核验');
 if(action==='ledger.reimburse'&&p.assetId==null)return gap('未指定到账资产的报销尚未真实核验');
 if(action==='debt.pay'&&typeof p.principal==='string'&&compareMoney(p.principal,'0')===0)return gap('仅利息还款尚未真实核验');
 if(action==='debt.create'&&Array.isArray(p.images)&&p.images.length)return gap('借贷初始图片关联尚未真实核验');
 if(action==='budget.submit'){
  if(Array.isArray(p.changes)&&p.changes.some(row=>obj(row).categoryId===null&&compareMoney(String(obj(row).limit),'0')===0))return gap('总预算清空尚未核验；分类预算可设0取消','BUDGET_TOTAL_CANCEL_UNVERIFIED');
  if(p.range)return gap('自定义预算周期写入尚未真实核验');
 }
 if(action==='repeat.submit'){
  if(p.mode==='create'&&(fields.type!==0||obj(fields.repeat).type!=='month'||fields.currency!=null))return gap('此周期规则或账单类型尚未真实核验');
  if(p.mode==='edit'&&Object.keys(changes).some(key=>key!=='remark'))return gap('周期任务其他字段编辑尚未真实核验');
 }
 if(action==='installments.create'&&(p.remainder!==undefined&&p.remainder!=='first'||p.feePlacement!==undefined&&p.feePlacement!=='ave'))return gap('此分期尾差或费用组合尚未真实核验');
 if(action==='installments.prepay'&&(p.spendCurrency!=null||p.transferCurrency!=null))return gap('外币提前还款尚未真实核验');
 if(action==='savings.submit'&&p.mode==='edit'&&Object.keys(changes).some(key=>key!=='remark'))return gap('存钱计划其他配置编辑尚未真实核验');
 return null;
}
export function assertWriteReleased(command:MutationCommand){const problem=writeReleaseProblem(command.action,command.input);if(problem)throw new DomainError(problem.code,problem.message);}
/** Recheck the effective records after loading current state, before the durable sending marker. */
export function assertPreparedWriteReleased(command:MutationCommand,prepared:PreparedMutation,repository:Repository):void{
 const p=asBillObject(prepared.payload),action=command.action,fail=(message:string):never=>{throw new DomainError('WRITE_LIVE_UNVERIFIED',message);};
 if(action==='assets.adjustBalance'){const raw=asBillObject(p.raw);if(numericText(raw.type,'')!=='1'||raw.currency!=='CNY')fail('仅CNY现金余额调整已真实核验');}
 if(action==='assets.submit'&&p.create!==true){const raw=asBillObject(p.raw);if(!['1','2'].includes(numericText(raw.type,'')))fail('此资产类型的编辑尚未真实核验');}
 if(action==='assets.delete'&&Array.isArray(p.impact)&&p.impact.length)fail('有关联账单的资产删除尚未真实核验');
 if(action==='books.delete'){
  const dataset=repository.dataset(command.scope,'ledger');if(!dataset?.complete||repository.sql.exec('SELECT 1 FROM bills WHERE uid=? AND dataset_id=? AND book_id=? LIMIT 1',command.scope.uid,dataset.id,String(p.id)).toArray().length)fail('仅完整核对过的空账本删除已真实核验');
 }
 if(action==='categories.delete'&&Array.isArray(p.beforeIds)&&p.beforeIds.length)fail('有关联账单的分类删除尚未真实核验');
 if(action==='tags.deleteTag'&&Array.isArray(p.beforeBillIds)&&p.beforeBillIds.length)fail('有关联账单的标签删除尚未真实核验');
 if(action==='tags.deleteGroup'||action==='assets.groups.delete'){
  const domain=action==='tags.deleteGroup'?'tags':'assets',kind=domain==='tags'?'tag':'asset',dataset=repository.dataset(command.scope,domain);
  if(!dataset||repository.sql.exec('SELECT 1 FROM resources WHERE uid=? AND domain=? AND dataset_id=? AND kind=? AND json_extract(raw,\'$.groupid\')=? LIMIT 1',command.scope.uid,domain,dataset.id,kind,String(p.id)).toArray().length)fail('非空分组删除尚未真实核验');
 }
 if(action==='ledger.delete'&&Array.isArray(p.entries)&&p.entries.some(entry=>!['0','1','20'].includes(numericText(asBillObject(asBillObject(entry).wire).type,''))))fail('此类型的账单删除尚未真实核验');
 if(['ledger.transfer','ledger.repayCard'].includes(action)&&Array.isArray(p.entries)&&p.entries.some(entry=>billExtra(asBillObject(asBillObject(entry).wire)).curr!=null))fail('此转账或还款历史币种组合尚未真实核验');
 if(action==='installments.create'&&numericText(asBillObject(p.wire).count,'0')!=='0')fail('创建时自动生成历史分期账单尚未真实核验');
 if(action==='budget.submit'){
  const params=asBillObject(p.params);const raw=params.changelist; if(typeof raw!=='string')fail('预算集合格式未确认');
  // Nested category aggregation is deliberately held until its complete native normalization is verified.
  const input=obj(command.input);if(Array.isArray(input.changes))for(const value of input.changes){const id=obj(value).categoryId;if(typeof id!=='string')continue;const record=repository.readResources(command.scope,'category',{domain:'ledger',ids:[id]}).items[0],category=record?asBillObject(record.raw):null;if(!category||positiveBillId(category.parentid))fail('二级分类预算及父子合并调整尚未真实核验');}
 }
}
