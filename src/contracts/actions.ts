import { z } from 'zod';
import { billFilterSchema, statisticsInputSchema } from '../features/ledger/contract';
import type { BillDetail, BillPage, CalendarView, StatisticsView, LedgerOptions } from '../features/ledger/contract';
import type { ConnectionView, RouteCheckView } from '../features/connection/contract';
import { syncInputSchema, type JobView } from '../features/sync/contract';
import type { OperationView } from '../operations/contract';
import type { CapabilityView } from './capabilities';
import { ledgerDraftSchema, createBillsSchema, deleteBillsSchema, editBillsSchema, type BillDraftView } from '../features/ledger/write-contract';
import { transferActionSchema, transferInputSchema, type TransferOptions, type TransferPreview } from '../features/ledger/transfer-contract';
import { refundInputSchema } from '../features/ledger/refund-contract';
import { cancelReimbursementInputSchema, reimburseInputSchema, reimbursableInputSchema, type ReimbursementMembers } from '../features/ledger/reimbursement-contract';
import { assetDraftSchema, assetDeleteSchema, assetGroupAddSchema, assetGroupDeleteSchema, assetGroupRemoveSchema, assetGroupReorderSchema, assetGroupSubmitSchema, assetIdSchema, assetListSchema, assetReorderSchema, assetSubmitSchema, assetTrendSchema, assetVisibleSchema, balanceAdjustmentSchema, debtFinishSchema, type AssetDetailView, type AssetDeleteCheckView, type AssetGroupsView, type AssetListView, type AssetTrendView, type AssetTypesView, type AssetDraftView, type AssetSummaryView } from '../features/assets/contract';
const empty = z.strictObject({}), id = z.string().min(1).max(200);
import { createDebtSchema, appendPrincipalSchema, editPrincipalSchema, debtPaymentSchema, debtListSchema, debtPreviewSchema, debtDraftSchema, type DebtListView, type DebtPreview, type DebtDraftView } from '../features/debt/contract';
import { bookListSchema, bookIdSchema, bookSubmitSchema, bookConfigureSchema, bookVisibleSchema, bookDeleteSchema, bookQuitSchema, bookReorderSchema, baseCurrencyInputSchema, bookDraftSchema, type BookListView, type BookTypesView, type BookMembersView, type BookDeleteCheckView, type BookDraftView, type AccountingConfigView } from '../features/books/contract';
import { categoryListSchema, categoryCheckSchema, categorySubmitSchema, categoryLevelSchema, categoryMoveSchema, categoryReorderSchema, categoryDeleteSchema, categoryDraftSchema, type CategoryDraftView, type CategoryListView, type CategoryDeleteCheckView } from '../features/categories/contract';
import { tagListSchema, tagWriteSchemas, tagDraftSchema, type TagDraftView, type TagListView } from '../features/tags/contract';
import { budgetQuerySchema, budgetChangesSchema, budgetDraftSchema, type BudgetDraftView, type BudgetView } from '../features/budget/contract';
import { uploadImageSchema, imageReferenceSchema, uploadDraftSchema, type UploadDraftView, type AttachmentOptions, type UploadedImage, type ImageView } from '../features/attachments/contract';
const route = z.strictObject({ route: z.enum(['main', 'backup', 'overseas']) });
export const actionSchemas = {
  'attachments.draft.applied': z.strictObject({ key: z.string().min(1).max(300), operationId: id }),
  'attachments.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'attachments.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: uploadDraftSchema }),
  'attachments.options': empty, 'attachments.resolve': imageReferenceSchema, 'attachments.result': z.strictObject({ operationId: id }), 'attachments.upload': uploadImageSchema.extend({ requestId: id }),
  'budget.list': budgetQuerySchema, 'budget.submit': budgetChangesSchema.safeExtend({ requestId: id }),
  'budget.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'budget.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: budgetDraftSchema }),
  'tags.list': tagListSchema,
  'tags.submitTag': z.discriminatedUnion('mode', [tagWriteSchemas['tags.submitTag'].options[0].extend({ requestId: id }), tagWriteSchemas['tags.submitTag'].options[1].extend({ requestId: id })]),
  'tags.submitGroup': z.discriminatedUnion('mode', [tagWriteSchemas['tags.submitGroup'].options[0].extend({ requestId: id }), tagWriteSchemas['tags.submitGroup'].options[1].extend({ requestId: id })]),
  'tags.reorderTags': tagWriteSchemas['tags.reorderTags'].safeExtend({ requestId: id }), 'tags.reorderGroups': tagWriteSchemas['tags.reorderGroups'].safeExtend({ requestId: id }),
  'tags.setArchived': tagWriteSchemas['tags.setArchived'].extend({ requestId: id }), 'tags.deleteTag': tagWriteSchemas['tags.deleteTag'].extend({ requestId: id }), 'tags.deleteGroup': tagWriteSchemas['tags.deleteGroup'].extend({ requestId: id }),
  'tags.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'tags.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: tagDraftSchema }),
  'categories.submit': z.discriminatedUnion('mode', [categorySubmitSchema.options[0].extend({ requestId: id }), categorySubmitSchema.options[1].safeExtend({ requestId: id })]),
  'categories.changeLevel': categoryLevelSchema.extend({ requestId: id }), 'categories.move': categoryMoveSchema.extend({ requestId: id }), 'categories.reorder': categoryReorderSchema.safeExtend({ requestId: id }), 'categories.delete': categoryDeleteSchema.safeExtend({ requestId: id }),
  'categories.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'categories.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: categoryDraftSchema }),
  'categories.list': categoryListSchema, 'categories.checkDelete': categoryCheckSchema,
  'books.list': bookListSchema, 'books.types': empty, 'books.members': z.strictObject({ id: bookIdSchema }), 'books.deleteCheck': z.strictObject({ id: bookIdSchema }), 'books.accounting': empty,
  'books.submit': z.discriminatedUnion('mode', [bookSubmitSchema.options[0].extend({ requestId: id }), bookSubmitSchema.options[1].safeExtend({ requestId: id })]),
  'books.configure': bookConfigureSchema.extend({ requestId: id }), 'books.setVisible': bookVisibleSchema.extend({ requestId: id }), 'books.delete': bookDeleteSchema.extend({ requestId: id }), 'books.quit': bookQuitSchema.extend({ requestId: id }), 'books.reorder': bookReorderSchema.extend({ requestId: id }), 'books.setBaseCurrency': baseCurrencyInputSchema.extend({ requestId: id }),
  'books.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'books.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: bookDraftSchema }),
  'connection.status': empty, 'connection.check': empty, 'connection.refresh': empty, 'connection.logout': empty,
  'connection.selectRoute': route, 'connection.testRoute': route,
  'sync.start': syncInputSchema, 'sync.status': z.strictObject({ jobId: id }),
  'ledger.options': empty, 'ledger.list': billFilterSchema, 'ledger.detail': z.strictObject({ id }),
  'ledger.calendar': z.strictObject({ year: z.int().min(1).max(9999), month: z.int().min(1).max(12), filter: billFilterSchema.optional(), cursor: z.string().max(4096).optional() }),
  'ledger.statistics': statisticsInputSchema, 'operations.get': z.strictObject({ operationId: id }), 'operations.reconcile': z.strictObject({ operationId: id }), 'capabilities.list': empty,
  'ledger.create': createBillsSchema.extend({ requestId: id }), 'ledger.edit': editBillsSchema.extend({ requestId: id }), 'ledger.delete': deleteBillsSchema.extend({ requestId: id }),
  'ledger.draft.get': z.strictObject({ key: z.string().min(1).max(100) }), 'ledger.draft.save': z.strictObject({ key: z.string().min(1).max(100), draft: ledgerDraftSchema }),
  'ledger.transfer': transferActionSchema, 'ledger.repayCard': transferActionSchema,
  'ledger.refund': refundInputSchema.safeExtend({ requestId: id }),
  'ledger.reimburse': reimburseInputSchema.extend({ requestId: id }), 'ledger.cancelReimbursement': cancelReimbursementInputSchema.extend({ requestId: id }),
  'ledger.setReimbursable': reimbursableInputSchema.extend({ requestId: id }), 'ledger.reimbursement.members': z.strictObject({ packId: z.string().regex(/^[1-9]\d{0,24}$/) }),
  'ledger.transfer.options': empty, 'ledger.transfer.preview': z.strictObject({ kind: z.enum(['transfer', 'repay-card']), input: transferInputSchema }),
  'assets.list': assetListSchema, 'assets.detail': z.strictObject({ id: assetIdSchema }), 'assets.types': empty, 'assets.groups.list': empty, 'assets.trend': assetTrendSchema,
  'assets.summary': assetListSchema.pick({ status: true, includeInstallments: true }),
  'assets.deleteCheck': z.strictObject({ id: assetIdSchema }),
  'assets.submit': z.discriminatedUnion('mode', [assetSubmitSchema.options[0].extend({ requestId: id }), assetSubmitSchema.options[1].extend({ requestId: id })]),
  'assets.adjustBalance': balanceAdjustmentSchema.safeExtend({ requestId: id }), 'assets.setFinished': debtFinishSchema.extend({ requestId: id }), 'assets.setVisible': assetVisibleSchema.extend({ requestId: id }),
  'assets.reorder': assetReorderSchema.extend({ requestId: id }), 'assets.delete': assetDeleteSchema.extend({ requestId: id }),
  'assets.groups.submit': assetGroupSubmitSchema.safeExtend({ requestId: id }), 'assets.groups.delete': assetGroupDeleteSchema.extend({ requestId: id }), 'assets.groups.reorder': assetGroupReorderSchema.extend({ requestId: id }),
  'assets.groups.add': assetGroupAddSchema.extend({ requestId: id }), 'assets.groups.remove': assetGroupRemoveSchema.extend({ requestId: id }),
  'assets.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'assets.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: assetDraftSchema }),
  'debt.list': debtListSchema, 'debt.options': empty, 'debt.preview': debtPreviewSchema,
  'debt.create': createDebtSchema.extend({ requestId: id }), 'debt.appendPrincipal': appendPrincipalSchema.extend({ requestId: id }), 'debt.editPrincipal': editPrincipalSchema.extend({ requestId: id }), 'debt.pay': debtPaymentSchema.extend({ requestId: id }),
  'debt.draft.get': z.strictObject({ key: z.string().min(1).max(300) }), 'debt.draft.save': z.strictObject({ key: z.string().min(1).max(300), draft: debtDraftSchema }),
} as const;
export type ActionName = keyof typeof actionSchemas;
export type ActionInput<A extends ActionName> = z.infer<typeof actionSchemas[A]>;
export interface ActionOutputs {
  'attachments.draft.applied': UploadDraftView; 'attachments.draft.get': UploadDraftView | null; 'attachments.draft.save': UploadDraftView; 'attachments.options': AttachmentOptions; 'attachments.resolve': ImageView; 'attachments.result': UploadedImage | null; 'attachments.upload': OperationView;
  'budget.list': BudgetView; 'budget.submit': OperationView; 'budget.draft.get': BudgetDraftView | null; 'budget.draft.save': BudgetDraftView;
  'tags.list': TagListView; 'tags.submitTag': OperationView; 'tags.submitGroup': OperationView; 'tags.reorderTags': OperationView; 'tags.reorderGroups': OperationView; 'tags.setArchived': OperationView; 'tags.deleteTag': OperationView; 'tags.deleteGroup': OperationView; 'tags.draft.get': TagDraftView | null; 'tags.draft.save': TagDraftView;
  'categories.submit': OperationView; 'categories.changeLevel': OperationView; 'categories.move': OperationView; 'categories.reorder': OperationView; 'categories.delete': OperationView; 'categories.draft.get': CategoryDraftView | null; 'categories.draft.save': CategoryDraftView;
  'categories.list': CategoryListView; 'categories.checkDelete': CategoryDeleteCheckView;
  'books.list': BookListView; 'books.types': BookTypesView; 'books.members': BookMembersView; 'books.deleteCheck': BookDeleteCheckView; 'books.accounting': AccountingConfigView;
  'books.submit': OperationView; 'books.configure': OperationView; 'books.setVisible': OperationView; 'books.delete': OperationView; 'books.quit': OperationView; 'books.reorder': OperationView; 'books.setBaseCurrency': OperationView; 'books.draft.get': BookDraftView | null; 'books.draft.save': BookDraftView;
  'connection.status': ConnectionView; 'connection.check': ConnectionView; 'connection.refresh': ConnectionView; 'connection.logout': ConnectionView;
  'connection.selectRoute': ConnectionView; 'connection.testRoute': RouteCheckView; 'sync.start': JobView | null; 'sync.status': JobView;
  'ledger.options': LedgerOptions; 'ledger.list': BillPage; 'ledger.detail': BillDetail; 'ledger.calendar': CalendarView; 'ledger.statistics': StatisticsView;
  'operations.get': OperationView; 'operations.reconcile': OperationView; 'capabilities.list': CapabilityView[];
  'ledger.create': OperationView; 'ledger.edit': OperationView; 'ledger.delete': OperationView; 'ledger.draft.get': BillDraftView | null; 'ledger.draft.save': BillDraftView;
  'ledger.transfer': OperationView; 'ledger.repayCard': OperationView; 'ledger.transfer.preview': TransferPreview; 'ledger.transfer.options': TransferOptions;
  'ledger.refund': OperationView;
  'ledger.reimburse': OperationView; 'ledger.cancelReimbursement': OperationView; 'ledger.setReimbursable': OperationView; 'ledger.reimbursement.members': ReimbursementMembers;
  'assets.list': AssetListView; 'assets.detail': AssetDetailView; 'assets.types': AssetTypesView; 'assets.groups.list': AssetGroupsView; 'assets.trend': AssetTrendView; 'assets.deleteCheck': AssetDeleteCheckView;
  'assets.submit': OperationView; 'assets.adjustBalance': OperationView; 'assets.setFinished': OperationView; 'assets.setVisible': OperationView; 'assets.reorder': OperationView; 'assets.delete': OperationView;
  'assets.groups.submit': OperationView; 'assets.groups.delete': OperationView; 'assets.groups.reorder': OperationView; 'assets.groups.add': OperationView; 'assets.groups.remove': OperationView;
  'assets.draft.get': AssetDraftView | null; 'assets.draft.save': AssetDraftView;
  'assets.summary': AssetSummaryView;
  'debt.list': DebtListView; 'debt.options': TransferOptions; 'debt.preview': DebtPreview;
  'debt.create': OperationView; 'debt.appendPrincipal': OperationView; 'debt.editPrincipal': OperationView; 'debt.pay': OperationView; 'debt.draft.get': DebtDraftView | null; 'debt.draft.save': DebtDraftView;
}
export interface ActionDefinition { title: string; description: string; kind: CapabilityView['kind']; evidence: CapabilityView['evidence']; requiresAccount: boolean; readOnly: boolean; destructive: boolean; unavailable?: { code: string; reason: string } }
const read = { kind: 'read', evidence: 'apk-static', requiresAccount: true, readOnly: true, destructive: false } as const;
const connection = { ...read, kind: 'connection', requiresAccount: false } as const;
const write = { ...read, kind: 'write', readOnly: false, unavailable: { code: 'WRITE_LIVE_UNVERIFIED', reason: '账单写入已完成契约与模拟测试，待专用测试账本真实验收后启用' } } as const;
const assetWrite = { ...write, unavailable: { code: 'WRITE_LIVE_UNVERIFIED', reason: '资产写入待命名测试资产真实验收后启用' } } as const;
export const actionDefinitions: Record<ActionName, ActionDefinition> = {
  'categories.submit': { ...write, title: '新增或编辑分类', description: '按账本及收支类型、编辑版本保存名称和图标，原生v是纯名称文本。新建使用官方返回ID；未知创建不按同名猜测，复用requestId。' },
  'categories.changeLevel': { ...write, title: '升级或降级分类', description: '明确parentId，null升为一级，同账本同收支一级父分类降为二级。有子项先处理子项；不自动递归迁移。复用requestId。' },
  'categories.move': { ...write, title: '移动二级分类', description: '按版本把现有二级分类移动到同账本、同收支类型的一级分类，保留真实分类ID与账单引用。复用requestId。' },
  'categories.reorder': { ...write, title: '排序分类', description: '完整提供各同级ID组，一级组在前；原生reorder3接收二维数字ID数组，不隐式移动层级。只读核对官方顺序，未知不重发。' },
  'categories.delete': { ...write, destructive: true, title: '删除分类并处理本人账单', description: '先检查子项及官方本人count/其他成员other。明确保留账单、删除本人账单或迁移至指定分类；跨账本迁移必须显式newBookId。仅调用deletev2，不额外上传逐笔修改；分类整数回执与本人账单同步分别核验。复用requestId。' },
  'categories.draft.get': { ...read, evidence: 'local', title: '读取分类草稿', description: '读取本账号结构化分类草稿及原操作，不请求钱迹。' },
  'categories.draft.save': { ...read, readOnly: false, evidence: 'local', title: '保存分类草稿', description: '保存本地分类管理输入，未知原操作未核清时禁止更换请求键重复提交。' },
  'attachments.draft.applied': { ...read, evidence: 'local', readOnly: false, title: '确认图片已保存到业务草稿', description: '只标记已成功的原上传，防止用户移除引用后重载重复添加；不修改或删除云端对象。' },
  'attachments.draft.get': { ...read, evidence: 'local', title: '读取图片上传草稿', description: '按业务表单读取原图片请求键及操作，重载后不创建重复上传。' }, 'attachments.draft.save': { ...read, evidence: 'local', readOnly: false, title: '保存图片上传草稿', description: '仅保存文件摘要、用途和原请求键，不保存图片字节；未核清原操作时拒绝替换。' },
  'attachments.options': { ...read, title: '图片上传选项', description: '读取官方max_bill_image及当前来源，原生fallback明确标记；不返回七牛token。闲置不刷新，过期配置按需检查。图片字节缺失时使用uploadPage网页入口。' },
  'attachments.resolve': { ...read, title: '解析图片显示地址', description: '按账单、封面或分类用途及尺寸构造原生样式URL，支持_hg长图。普通URL仅作为显示引用，uploaded=false，不能证明上传成功或直接关联新账单。' },
  'attachments.result': { ...read, evidence: 'local', title: '读取原图片上传结果', description: '按原operationId读取已确认对象key和purpose-specific associationValue；未知上传在只读证明前返回null，不换键重传。' },
  'attachments.upload': { ...write, title: '上传官方钱迹图片', description: '提供已按APK处理的JPEG账单/封面或PNG图标base64，单张8MiB以内；无字节时前往网页上传入口。先确认官方区域和临近过期凭证，仅发送一次对象上传。日志只保存元数据，未知结果只读核查原对象；成功后用attachments.result取得已确认引用。必须复用requestId。' },
  'budget.list': { ...read, title: '查询预算与执行进度', description: '按账本、月/年日期、原生range及其时区分别缓存官方配置和daystats；执行计算复用APK预算口径，父子分类可重叠，总额独立，不叠加父子进度。标明副本完整性及历史退款依赖。闲置不请求。' },
  'budget.submit': { ...write, title: '设置总预算或分类预算', description: '按配置版本提交原生submitv2/changelist，金额0沿用原生取消预算语义；保留未知字段，应用官方返回预算集合而非复制输入。只支持已核对月度/年度及自定义月界，不推断独立季度预算或结转任务。复用requestId，未知结果只读核查。' },
  'budget.draft.get': { ...read, evidence: 'local', title: '读取预算草稿', description: '读取结构化本地预算输入与原操作，不请求钱迹。' }, 'budget.draft.save': { ...read, evidence: 'local', readOnly: false, title: '保存预算草稿', description: '保存原日期、账本与请求键，未知操作未核清时禁止覆盖重建。' },
  'tags.list': { ...read, title: '查询标签和分组', description: '按原生tag/list的status=-1、lasttime=0读取完整目录，保留归档历史、字符串ID和官方分组；默认不返回归档标签，可显式includeArchived。空目录同样缓存60秒，闲置不请求。' },
  'tags.submitTag': { ...write, title: '新增或编辑标签', description: 'v为name/groupid/color的JSON，颜色为原生六位或八位无井号十六进制。按版本编辑，官方返回Tag为准；新建响应丢失不按同名认领。复用requestId。' },
  'tags.submitGroup': { ...write, title: '新增或编辑标签组', description: 'v为纯名称文本，原生组名最长10字，组ID为不透明字符串；未知新建仅核查原操作。复用requestId。' },
  'tags.reorderTags': { ...write, title: '排序同组标签', description: '同组真实字符串ID数组，不跨组移动、不用数字强制转换；成功后只读核对官方次序。复用requestId。' },
  'tags.reorderGroups': { ...write, title: '排序标签组', description: '原生reordergroup使用字符串ID数组，完成后只读核对，不重复发送未知操作。复用requestId。' },
  'tags.setArchived': { ...write, title: '归档或恢复标签', description: 'archived是明确目标；先强制读取最新Tag，已达到则不调用切换。否则仅调用一次archivetag并使用官方返回Tag，不清空账单标签。复用requestId。' },
  'tags.deleteTag': { ...write, destructive: true, title: '删除标签', description: '按最新版本删除标签，关联账单引用另外等待只读同步核查。不会伪造逐笔修改，不把归档当删除。复用requestId。' },
  'tags.deleteGroup': { ...write, destructive: true, title: '删除标签组', description: '只删除组并把包括归档在内的标签移至未分组；保留标签和账单。未知结果只读核查，复用requestId。' },
  'tags.draft.get': { ...read, evidence: 'local', title: '读取标签草稿', description: '读取结构化本地草稿及原操作，不请求钱迹。' }, 'tags.draft.save': { ...read, evidence: 'local', readOnly: false, title: '保存标签草稿', description: '未知原操作未核清时保留原请求键，防止重复提交。' },
  'categories.list': { ...read, title: '查询分类层级', description: '按账本及收支类型读取原生listv2，将sublist规范化为同一分类实体和两级关系，保留官方editable、ID及编辑版本。60秒按需来源缓存，失败保留旧资料并标记。' },
  'categories.checkDelete': { ...read, title: '检查分类删除影响', description: '先读取完整分类树；有子项的父分类先处理子项。官方count/other分别展示本人及其他成员引用数，不用本地计数猜测他人账单不存在。此动作不修改数据。' },
  'books.list': { ...read, title: '查询账本', description: '按原生t=-1读取当前账号全部类型账本，可显式包含隐藏项；保留所有者/成员身份、默认账本及各自过期状态。来源按需60秒缓存，闲置不请求。' },
  'books.types': { ...read, title: '查询账本模板类型', description: '读取官方账本类型、名称、默认封面与账期，不自造模板编码。' },
  'books.members': { ...read, title: '查询账本成员', description: '按真实账本ID读取已有云端成员、姓名及所有者身份，不建设本服务多用户或角色系统。' },
  'books.deleteCheck': { ...read, title: '检查账本删除条件', description: '读取最新账本与官方未结事项检查；新owner/member字段优先，仅两者均缺失时兼容旧has_unresolved。默认账本不能删除；删除时再次检查。' },
  'books.accounting': { ...read, title: '读取本位币业务配置', description: '读取client/init的userconfigs.basecur及来源时间；本位币属于账号业务配置，与账本周期range分开。默认CNY明确标记未验证来源，不按当前汇率改写历史账单。' },
  'books.submit': { ...write, title: '新建或编辑账本', description: '通过官方book/submit保存名称、封面及账期，新建使用官方类型和返回ID，编辑按版本及当前所有者身份核对。未知创建不按同名认定成功，必须复用requestId。' },
  'books.configure': { ...write, title: '设置账本业务周期', description: '通过原生book/config保存range，支持自然月、起始日1–28、全年、季度或全部。应用官方账本回执，失效统计与预算依赖；range不是另建预算或后台任务。复用requestId。' },
  'books.setVisible': { ...write, title: '设置账本显隐', description: '明确visible目标，先读最新账本，已达到时不调用原生切换。成功或未知后只读核对，禁止重复切换追逐目标。' },
  'books.reorder': { ...write, title: '排序账本', description: '按真实账本ID数组调用官方排序，通过完整列表只读核对相对顺序，未知时不重发。' },
  'books.delete': { ...write, destructive: true, title: '删除云端账本', description: '仅所有者、非默认账本，按最新版本及deletecheck未结事项结果提交官方delete。将删除该账本账单；与退出共享账本分开，无跨资源通用级联开关。复用requestId。' },
  'books.quit': { ...write, destructive: true, title: '退出账本或移除已有成员', description: '使用官方quit及明确memberId；参与者只能退出自己，所有者可移除当前名单中的其他成员。本人退出才清理本地该账本副本，移除他人保留账本。涉及其他成员的实际动作需用户具体命令，不自动邀请或批量清理。' },
  'books.setBaseCurrency': { ...write, title: '设置账号本位币', description: '仅通过原生user/updateconfig更新basecur，按配置版本核对。成功后共享给统计、资产、转账、退款与借贷，失效依赖计算；未知时保留原值并只读核对，绝不重写历史金额或自动重发。' },
  'books.draft.get': { ...read, evidence: 'local', title: '读取账本草稿', description: '读取本地结构化账本草稿及原请求键对应操作，不请求钱迹。' },
  'books.draft.save': { ...read, readOnly: false, evidence: 'local', title: '保存账本草稿', description: '只保存输入草稿，未核清原操作时不能覆盖请求键重新创建。' },
  'debt.list': { ...read, title: '查询借贷', description: '按借入或借出、结清状态调用原生listloan，与资产列表共用真实资产ID和官方余额。按需60秒刷新，缺少LoanInfo时展示缺失状态，不能按零推算本金。' },
  'debt.options': { ...read, title: '借贷账本与关联资产选项', description: '按需载入当前资产与账本；借贷只允许选择本位币普通资产或信用卡，不使用当前汇率自动换算。' },
  'debt.preview': { ...read, evidence: 'local', title: '预览借贷本金及利息', description: '仅根据本地已载入资料计算原生本金、利息拆分及预期LoanInfo和资金变化，不写入钱迹。超出余额的本金输入会归入利息；预期值不是已确认资产余额。' },
  'debt.create': { ...assetWrite, title: '新建借入或借出', description: 'asset.submit由官方返回新借贷ID和初始本金账单，不能再补造初始记录。需目标账本、金额、日期及可选本位币实际资金资产。复用requestId，未知结果不凭同名猜测成功。' },
  'debt.appendPrincipal': { ...write, title: '追加借贷本金', description: '按资产详情版本创建type6借入或7借出本金记录，沿用LoanInfo累计本金及余额方向；只通过bill.syncall上传，不另发资产余额修改。未知结果只读核查原操作。' },
  'debt.editPrincipal': { ...write, title: '编辑借贷本金记录', description: '仅编辑真实type6/7本金，按原账单版本保留ID；旧资产回滚、新资产应用后合并预期差额。本位币且LoanInfo完整；不支持把4/9/10/11当成本金编辑。复用requestId。' },
  'debt.pay': { ...write, title: '还款或收回借贷', description: '借入生成9本金/10利息，借出生成4本金/11利息；本金为零时只生成利息。输入本金超过余额时超出部分替换利息。两条记录独立ID与结果，部分成功不承诺原子性，不自动结清、不额外asset.submit，金额各自不超过9999999999。必须复用requestId。' },
  'debt.draft.get': { ...read, evidence: 'local', title: '读取借贷草稿', description: '读取结构化本地草稿和原请求键对应的操作，不请求钱迹。' },
  'debt.draft.save': { ...read, readOnly: false, evidence: 'local', title: '保存借贷草稿', description: '保存本地本金、利息与关联资产输入，未核清的原操作禁止替换请求键重复提交。' },
  'connection.status': { ...connection, title: '钱迹连接状态', description: '读取本服务连接状态、当前线路及登录有效性，不请求钱迹。' },
  'connection.check': { ...connection, title: '检查登录状态', description: '主动请求钱迹配置，检查当前登录状态。' },
  'connection.refresh': { ...connection, title: '刷新登录状态', description: '查询刷新能力；未验证时请在连接页面重新登录。', unavailable: { code: 'REFRESH_UNVERIFIED', reason: '令牌刷新尚未真实验证，请在连接页面重新登录' } },
  'connection.logout': { ...connection, readOnly: false, destructive: true, title: '退出钱迹连接', description: '退出本服务的钱迹连接并清除保存的登录凭证。' },
  'connection.selectRoute': { ...connection, readOnly: false, title: '切换钱迹线路', description: '选择主、备用或海外线路，后续请求使用所选线路。' },
  'connection.testRoute': { ...connection, title: '检测钱迹线路', description: '登录后检测所选线路，不改变当前线路。' },
  'sync.start': { ...read, kind: 'sync', title: '同步钱迹数据', description: '按需增量同步或重建本服务副本。复用进行中的任务；重复调用不会重复启动。使用 sync.status 查看任务。' },
  'sync.status': { ...read, kind: 'sync', title: '查看同步任务', description: '只读任务进度，不重启同步，也不再次请求钱迹。' },
  'ledger.list': { ...read, title: '查询账单', description: '组合日期、账本、分类、成员、标签、资产及精确金额筛选。金额和 ID 为文本。running 时数据是已确认缓存，尚未完成更新。' },
  'ledger.options': { ...read, title: '账单筛选选项', description: '读取已经载入的账本、分类和标签名称及完整性，不额外请求钱迹。' },
  'ledger.detail': { ...read, title: '账单详情', description: '读取真实账单与跨期退款、报销关联，明确缺失资料与数据时间。' },
  'ledger.calendar': { ...read, title: '账单日历', description: '按自然月与指定时区统计真实账单条数，展示完整性及分页。' },
  'ledger.statistics': { ...read, evidence: 'native-vector', title: '收支统计', description: '按 APK 口径计算收支、退款、报销、历史币种、趋势、分组和同期比较。多标签或父子分类分组可重叠，禁止将这些分组再相加当总额。running 时等待同一任务完成后重读。' },
  'ledger.create': { ...write, title: '新增账单', description: '批量新增普通支出、收入、待报销支出。enteredMoney为录入原价，fee为负数优惠，优惠仅扣一次。必须提供稳定requestId；未知结果只查询operationId，不换键重建。' },
  'ledger.edit': { ...write, title: '编辑账单', description: '按详情editVersion选择性修改完整账单，保留未修改字段。必须提供稳定requestId；云端副本变化时保留草稿并重看详情。' },
  'ledger.delete': { ...write, destructive: true, title: '删除账单', description: '按真实账单ID和详情editVersion批量删除，逐项查看回执。必须提供稳定requestId，未确认项目仅核查原操作。有关联记录时使用对应专用操作。' },
  'ledger.transfer': { ...write, destructive: true, title: '管理转账', description: '新增/编辑/删除一笔真实转账。enteredMoney是录入额，fee正为手续费、负为优惠；本金扣一次绝对费用。预期资产变动与上游确认余额分开。始终复用requestId，未知结果核查operationId。' },
  'ledger.repayCard': { ...write, destructive: true, title: '管理信用卡还款', description: '新增/编辑/删除一笔type3还款，复用转账费用和历史币种规则。只有新增且日期更晚才推进本地最新还款日期预期；删除不自动回退日期。复用requestId，不重发未知结果。' },
  'ledger.transfer.preview': { ...read, evidence: 'native-vector', title: '预览转账或还款', description: '使用已载入资料计算本金、转出/转入金额、合并资产预期变动。预览不上传账单，预期余额不代表上游确认；无币种资料时不擅自按当前汇率换算。' },
  'ledger.transfer.options': { ...read, title: '转账资产与账本选项', description: '读取已载入的资产名称、类型、币种、确认余额和账本选项，不额外请求钱迹。' },
  'ledger.refund': { ...write, title: '新增或编辑退款', description: '调用官方refund2并同时应用源与子账单。billId为源ID，编辑另带refundBillId和对应版本；有退款源不能换类型，新增保留原生25次限制。money省略时新退款采用原生剩余金额；显式正数不自行加上剩余额度上限。清空字段尚未验证时明确不可用。复用requestId，未知结果只核查原operationId。' },
  'ledger.reimburse': { ...write, title: '报销入账', description: '按源时间与长ID升序分配，末笔承接余数，可超过剩余本金。一次返回源与真实type21子记录，官方资产余额仅保存一次。不同源币种不可混算，多币种需提供历史三币种金额。必须复用requestId，未知结果仅核查原operationId。' },
  'ledger.cancelReimbursement': { ...write, destructive: true, title: '取消报销', description: '按源账单版本调用取消报销，保留type5待报销属性。成功码后仍只读核对源关系、真实子记录和资产；不自动发送额外子删除，不自动升级旧报销数据。必须复用requestId。' },
  'ledger.setReimbursable': { ...write, title: '设置待报销属性', description: '按详情版本将普通支出标记为待报销，或在没有新版/旧版报销时取消该属性；保留退款和其他字段。与取消报销分开，复用requestId。' },
  'ledger.reimbursement.members': { ...read, title: '读取报销组合成员', description: '按packId读取完整副本中的真实type21成员及版本，最多200条；complete=false时禁止把当前页冒充整组。虚拟type22不会产生云端ID或额外统计。' },
  'assets.list': { ...read, title: '查询资产与汇总', description: '按原生status0正常或2隐藏读取资产、分组和按币种汇总；60秒内合并复用已校验来源，闲置不请求。包装项不重复计入，借贷方向、incount与信用卡分期选项沿用APK。金额不跨币种盲加，分页不影响整个来源汇总。' },
  'assets.summary': { ...read, title: '资产汇总', description: '只返回整个已校验资产来源的分币种汇总及完整性，不返回单项资产列表。与列表共用缓存和APK计算规则，不另做金额相加或额外刷新。' },
  'assets.detail': { ...read, title: '资产详情', description: '按资产ID读取官方资料、余额、类型及编辑版本；写后余额以完整官方回执或上游读取为准。' },
  'assets.types': { ...read, title: '资产类型选项', description: '读取APK使用的官方类型/子类型、分组及图标标识，不将未知类型映射成现金。' },
  'assets.groups.list': { ...read, title: '查询资产分组', description: '读取官方分组ID、名称、排序及编辑版本。分组ID是字符串。' },
  'assets.trend': { ...read, title: '查询历史资产趋势', description: '读取官方assetline历史快照，单次一年以内。空历史保持空，不从账单伪造历史余额或插值。' },
  'assets.deleteCheck': { ...read, title: '检查资产删除影响', description: '普通资产按官方deletecheck核对周期/分期引用，借贷沿用原生跳过该检查的路径。列出会删除的转账/借贷记录及会解除资产关联的账单；需要完整账单副本。此操作不删除任何资料。' },
  'assets.submit': { ...assetWrite, title: '新增或编辑资产资料', description: '新增普通、储值、投资或信用卡资产，使用官方返回ID；按详情版本编辑名称、备注、统计标记及信用卡资料，保留未知字段。余额修改使用adjustBalance，借贷本金使用专用流程。始终复用requestId，未知结果只查原operationId。' },
  'assets.adjustBalance': { ...assetWrite, title: '调整资产余额', description: '原生asset.submit可选择是否记录差额；记录时传分类与独立统计/预算标记，并仅应用官方关联账单。money为原生输入余额，已有未还分期会按原生换算存储值。账号内任何未同步账单都会阻止变更。复用requestId，不自动补造调整账单。' },
  'assets.setFinished': { ...assetWrite, title: '设置借贷结清状态', description: '以finished明确目标，每次强制读最新资产，已达目标则不调用finish。成功码后仍读实际状态；未知结果绝不再次切换。结清保留余额，不等于生成还款账单。必须复用requestId。' },
  'assets.setVisible': { ...assetWrite, title: '设置资产显隐', description: '按visible明确目标，强制读取当前状态避免旧缓存反向切换；仅一次原生visible调用，未知时只读核查。' },
  'assets.reorder': { ...assetWrite, title: '排序资产', description: '按真实ID数组调用原生排序，读取官方列表核对次序，不把本地排序当成上游确认。复用requestId。' },
  'assets.delete': { ...assetWrite, destructive: true, title: '删除资产', description: '按详情版本与原生依赖检查删除资产；可能删除相关转账/借贷记录，并解除其他账单资产关联。使用deleteCheck先查看具体影响，无通用级联开关；回执及账单核查分开，未知结果不重发。' },
  'assets.groups.submit': { ...assetWrite, title: '新增或编辑资产分组', description: '创建或按版本编辑官方分组名称，使用官方字符串ID；复用requestId，未知新建结果不凭同名猜测完成。' },
  'assets.groups.delete': { ...assetWrite, destructive: true, title: '删除资产分组', description: '按官方分组ID与版本提交删除，读分组列表核对结果，不调用资产删除接口。' },
  'assets.groups.reorder': { ...assetWrite, title: '排序资产分组', description: '按字符串分组ID数组排序，成功后读取官方分组顺序核对。' },
  'assets.groups.add': { ...assetWrite, title: '将资产加入分组', description: '按官方分组ID和真实资产ID加入分组，按原生现有成员数追加排序位置；单次最多20个资产，成功码后只读核对实际归属。复用requestId。' },
  'assets.groups.remove': { ...assetWrite, title: '解除指定资产分组', description: '先强制读资产最新归属；已离开指定分组时不清除另一个分组。仅一次removeasset调用，未知结果只核查。' },
  'assets.draft.get': { ...read, evidence: 'local', title: '读取资产草稿', description: '读取本地结构化资产草稿及原请求键对应操作，不请求钱迹。' },
  'assets.draft.save': { ...read, readOnly: false, evidence: 'local', title: '保存资产草稿', description: '只保存本地输入，已有未知结果时保留原请求键，不能覆盖草稿重复创建。' },
  'ledger.draft.get': { ...read, evidence: 'local', title: '读取账单草稿', description: '读取本账号的本地账单草稿和同一请求键已产生的operationId，不请求钱迹。' },
  'ledger.draft.save': { ...read, readOnly: false, evidence: 'local', title: '保存账单草稿', description: '只保存结构化本地草稿，不上传账单。已有未核清操作时不能替换草稿或请求键。' },
  'operations.get': { ...read, kind: 'reconciliation', title: '查看写操作结果', description: '读取操作日志、逐项结果及确定性，不发送写入。' },
  'operations.reconcile': { ...read, kind: 'reconciliation', title: '核查未知写入结果', description: '通过只读上游查询核查原操作，绝不重发已发送写入。' },
  'capabilities.list': { ...read, evidence: 'local', requiresAccount: false, title: '查看可用功能', description: '读取当前连接下各动作的证据阶段、可用性与不可用原因。模拟测试成功不代表真实验收通过。' },
};
export const actionRequestSchema = z.strictObject({ action: z.string().min(1).max(100), input: z.unknown().default({}), meta: z.strictObject({ requestId: id.optional() }).default({}) });
