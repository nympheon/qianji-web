import {DomainError} from '../../src/shared/errors';
import {jpegBase64,pngBase64} from './images.mts';
import type {CaseEnvironment} from './cases.mts';
export async function runMedia(e:CaseEnvironment){
 await e.synchronize();await e.read('attachments.options',{});await e.read('ledger.transfer.options',{},true);
 const uploaded:Record<string,string>={};
 for(const purpose of ['bill','cover','category'] as const){
  const op=await e.write('media-'+purpose,'attachments.upload',{purpose,mime:purpose==='category'?'image/png':'image/jpeg',dataBase64:purpose==='category'?pngBase64:jpegBase64});
  const image=await e.read('attachments.result',{operationId:op.id});if(!image||image.purpose!==purpose||image.proof!=='qiniu-receipt'||image.width!==32||image.height!==32)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','图片对象回执、用途或尺寸无法核对');
  e.remember('image-'+purpose,'attachment',image.key);uploaded[purpose]=purpose==='bill'?image.key:image.associationValue;
  await e.read('attachments.resolve',{reference:uploaded[purpose]!,purpose,size:'original'});
 }
 if(!e.optional('media-associated-bill')){
  const result=await e.write('media-bill-associate','ledger.create',{bills:[{bookId:e.known('book'),type:0,categoryId:e.known('expense-category'),assetId:null,enteredMoney:'0.01',fee:'0',timeSec:Math.floor(Date.now()/60000)*60,remark:e.prefix+'图片关联账单',images:[uploaded.bill]}]});const bill=result.items.find(item=>item.state==='succeeded'&&/^[1-9]\d+$/.test(item.id));if(!bill)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','图片测试账单未确认');e.remember('media-associated-bill','bill',bill.id);
 }
 await e.synchronize();if(!(await e.read('ledger.detail',{id:e.known('media-associated-bill')})).images.includes(uploaded.bill!))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','图片未关联至实际官方账单');
 let book=(await e.read('books.list',{includeHidden:true})).items.find(item=>item.id===e.known('book'));if(!book)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试账本不存在');
 await e.write('media-cover-associate','books.submit',{mode:'edit',id:book.id,expectedVersion:book.editVersion,cover:uploaded.cover});book=(await e.read('books.list',{includeHidden:true})).items.find(item=>item.id===e.known('book'));if(book?.cover!==uploaded.cover)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','封面未关联至测试账本');
 let category=(await e.read('categories.list',{bookId:e.known('book'),type:0})).items.find(item=>item.id===e.known('category-child'));if(!category)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试分类不存在');await e.write('media-icon-associate','categories.submit',{mode:'edit',bookId:e.known('book'),type:0,id:category.id,expectedVersion:category.editVersion,icon:uploaded.category});category=(await e.read('categories.list',{bookId:e.known('book'),type:0})).items.find(item=>item.id===e.known('category-child'));if(category?.icon!==uploaded.category)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','分类图标未关联至测试分类');
 return {state:'ready',threePurposeObjectReceiptsAndBusinessAssociations:true};
}
