import {DomainError} from '../../src/shared/errors';
import {compareMoney} from '../../src/shared/numbers';
import {assetInfoKey} from '../../src/features/assets/service';
import {assetGroupKey} from '../../src/features/assets/groups';
import type {CaseEnvironment} from './cases.mts';
const oneId=(op:Awaited<ReturnType<CaseEnvironment['write']>>)=>{const ids=Object.values(op.idMap);if(ids.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','新建资源缺少唯一回执ID');return ids[0]!;};
export async function runAssets(e:CaseEnvironment){
 await e.synchronize();await e.read('assets.types',{});await e.read('categories.list',{bookId:e.known('book'),type:1});
 if(!e.optional('balance-asset'))e.remember('balance-asset','asset',oneId(await e.write('balance-asset-create','assets.submit',{mode:'create',fields:{name:e.prefix+'余额调整专用',type:1,subtype:11,currency:'CNY',money:'0',inCount:false}})));
 const id=e.known('balance-asset');
 const detail=async()=>{e.invalidateSource(assetInfoKey(id));const result=await e.read('assets.detail',{id},true);if(!result.asset)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试资产详情不存在');return result.asset;};
 let asset=await detail();
 await e.write('balance-asset-edit','assets.submit',{mode:'edit',id,expectedVersion:asset.editVersion,changes:{remark:e.prefix+'资产资料已修改'}});
 asset=await detail();if(asset.remark!==e.prefix+'资产资料已修改')throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','资产资料修改未回拉');
 await e.write('balance-no-bill','assets.adjustBalance',{id,expectedVersion:asset.editVersion,money:'2',recordDifference:false});asset=await detail();if(compareMoney(asset.money,'2'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','不记差额的余额调整未回拉');
 const adjusted=await e.write('balance-with-bill','assets.adjustBalance',{id,expectedVersion:asset.editVersion,money:'3',recordDifference:true,difference:{categoryId:e.known('income-category'),countInStatistics:false,countInBudget:false,remark:e.prefix+'余额差额收入'}});
 await e.synchronize();asset=await detail();if(compareMoney(asset.money,'3'))throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','记录差额后的余额不符');
 const bills=adjusted.affectedIds.filter(value=>/^[1-9]\d+$/.test(value));if(bills.length!==1)throw new DomainError('ACCEPTANCE_ID_UNPROVEN','差额账单缺少唯一回执ID');e.remember('balance-difference','bill',bills[0]!);
 const difference=await e.read('ledger.detail',{id:bills[0]!});if(difference.bookId!==e.known('book')||difference.type!==1||compareMoney(difference.money,'1')||difference.flags!==3)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','差额账单的账本、金额或排除标记不符');
 await e.write('balance-hide','assets.setVisible',{id,visible:false});if((await detail()).visible)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','资产隐藏未生效');
 await e.write('balance-show','assets.setVisible',{id,visible:true});if(!(await detail()).visible)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','资产恢复显示未生效');
 await e.read('assets.groups.list',{},true);
 if(!e.optional('asset-group'))e.remember('asset-group','assetGroup',oneId(await e.write('asset-group-create','assets.groups.submit',{id:null,name:e.prefix+'测试资产分组'})));
 const groupId=e.known('asset-group');await e.write('asset-group-add','assets.groups.add',{groupId,assetIds:[id]});if((await detail()).groupId!==groupId)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','资产加入分组未生效');
 await e.write('asset-group-remove','assets.groups.remove',{groupId,assetId:id});if((await detail()).groupId===groupId)throw new DomainError('ACCEPTANCE_READBACK_MISMATCH','资产移出分组未生效');
 e.invalidateSource(assetGroupKey);const group=(await e.read('assets.groups.list',{},true)).items.find(item=>item.id===groupId);if(!group)throw new DomainError('ACCEPTANCE_SOURCE_INCOMPLETE','测试分组未回拉');await e.write('asset-group-delete','assets.groups.delete',{id:groupId,expectedVersion:group.editVersion});
 return {state:'ready',metadataBalanceDifferenceVisibilityAndGroups:true};
}
