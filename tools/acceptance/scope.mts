import { DomainError } from '../../src/shared/errors';
import { isLosslessNumber } from 'lossless-json';
import { parseWire } from '../../src/shared/wire-json';
import type { PreparedMutation } from '../../src/operations/contract';

export type TestResource = 'book'|'asset'|'category'|'bill'|'tag'|'tagGroup'|'assetGroup'|'repeat'|'installment'|'pack'|'saving'|'transaction'|'attachment';
export interface AcceptanceManifest {
  uid:string; prefix:string; actions:readonly string[];
  resources:Partial<Record<TestResource,readonly string[]>>;
}
function deny(detail:string):never{throw new DomainError('ACCEPTANCE_SCOPE_DENIED',detail);}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Only imported by the local acceptance entry, never by the production Worker. */
export class AcceptanceScope {
  constructor(readonly manifest:AcceptanceManifest){
    if(!manifest.uid||manifest.prefix.length<6||!manifest.actions.length)deny('验收必须绑定账号、命名前缀和明确操作清单');
  }
  private target(action:string):TestResource {
    if(action.startsWith('ledger.'))return 'bill';
    if(action.startsWith('debt.'))return action==='debt.editPrincipal'?'bill':'asset';
    if(action.startsWith('assets.groups.'))return 'assetGroup';
    if(action.startsWith('assets.'))return 'asset';
    if(action.startsWith('books.'))return 'book';
    if(action.startsWith('categories.'))return 'category';
    if(action.startsWith('tags.'))return /Group/.test(action)?'tagGroup':'tag';
    if(action.startsWith('repeat.'))return 'repeat';
    if(action.startsWith('installments.'))return 'installment';
    if(action.startsWith('savings.'))return 'saving';
    if(action.startsWith('attachments.'))return 'attachment';
    if(action.startsWith('budget.'))return 'book';
    return deny('此领域不在真实写入验收范围');
  }
  private reference(kind:TestResource,value:unknown){
    if(typeof value!=='string'||!this.manifest.resources[kind]?.includes(value))deny(`目标不在本次新建的测试${kind}清单中`);
  }
  authorizePrepared(uid:string,prepared:PreparedMutation):void {
    if(uid!==this.manifest.uid)deny('准备发送的账号不属于本次验收');
    const walk=(value:unknown,key:string):void=>{
      if(value==null)return;
      if(isLosslessNumber(value))value=value.value;
      if(Array.isArray(value)){for(const child of value)walk(child,key);return;}
      if(value!==null&&typeof value==='object'){for(const [childKey,child]of Object.entries(value))walk(child,childKey);return;}
      if(typeof value==='string'&&['v','extra','diffparams','billInfo'].includes(key)&&/^[\s]*[\[{]/.test(value)){walk(parseWire(value),'');return;}
      const text=typeof value==='number'?String(value):value;
      if(/^(uid|userid)$/i.test(key)&&text!==this.manifest.uid)deny('准备发送的账号与验收清单不同');
      if(/^bookid$/i.test(key))this.reference('book',text);
      if(/^(cateid|categoryid)$/i.test(key)&&text!==''&&text!=='-1'&&text!=='0')this.reference('category',text);
      if(/^(assetid|fromid|targetid|accountid|shareid|outassetid|inassetid)$/i.test(key)&&text!==''&&text!=='-1'&&text!=='0')this.reference('asset',text);
    };
    walk(prepared.payload,'');
  }
  authorize(uid:string,action:string,input:unknown):void {
    if(uid!==this.manifest.uid||!this.manifest.actions.includes(action))deny('账号或操作与验收清单不符');
    if(action==='books.setBaseCurrency'||action==='books.quit'||action.startsWith('connection.'))deny('全局配置与现有成员不属于测试资源');
    const root=object(input),prefix=this.manifest.prefix;
    if(typeof root.requestId!=='string'||!root.requestId.startsWith(prefix))deny('验收请求必须沿用本次稳定命名编号');
    if(root.requestId.startsWith(prefix+':cleanup-')&&action==='savings.delete'&&root.deleteBills!==false)deny('清理计划必须保留关联账单，只由已证明的新测试账本负责删除');
    const target=this.target(action);
    const named=(value:unknown)=>{if(typeof value!=='string'||!value.startsWith(prefix))deny('新建或改名必须使用本次测试前缀');};
    const walk=(value:unknown,key:string):void=>{
      if(value==null)return;
      if(Array.isArray(value)){if(value.length>200)deny('验收批次数量超出范围');for(const child of value)walk(child,action==='categories.reorder'&&key==='groups'?'id':key.replace(/Ids$/,'Id').replace(/^ids$/,'id'));return;}
      if(typeof value==='object'){for(const [childKey,child]of Object.entries(value))walk(child,childKey);return;}
      if(key==='requestId'||key==='expectedVersion')return;
      if(key==='name'){named(value);return;}
      let kind:TestResource|undefined;
      if(/bookId$/i.test(key))kind='book';
      else if(/assetId$/i.test(key)||key==='fromId'||key==='targetId')kind='asset';
      else if(/categoryId$/i.test(key)||key==='parentId'||key==='newCategoryId')kind='category';
      else if(/tagId$/i.test(key))kind='tag';
      else if(/billId$/i.test(key)||key==='sourceId')kind='bill';
      else if(key==='transId')kind='transaction';
      else if(key==='packId')kind='pack';
      else if(key==='planId')kind=target;
      else if(key==='groupId')kind=action.startsWith('tags.')?'tagGroup':'assetGroup';
      else if(key==='id')kind=target;
      else if(/Id$/i.test(key))deny('未审查的身份引用字段');
      if(kind)this.reference(kind,value);
    };
    walk(root,'');
    if(action==='ledger.create'){
      if(!Array.isArray(root.bills)||!root.bills.length||root.bills.length>20)deny('测试新增账单最多20笔');
      for(const row of root.bills){const bill=object(row);this.reference('book',bill.bookId);named(bill.remark);}
    }
    if(action==='books.submit'&&root.mode==='create')named(root.name);
    if(action==='repeat.submit'&&root.mode==='create'){const fields=object(root.fields);this.reference('book',fields.bookId);named(fields.remark);}
    if(action==='categories.submitMany')for(const item of root.items as unknown[]??[])named(object(item).name);
  }
}
