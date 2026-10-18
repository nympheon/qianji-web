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
const empty = z.strictObject({}), id = z.string().min(1).max(200);
const route = z.strictObject({ route: z.enum(['main', 'backup', 'overseas']) });
export const actionSchemas = {
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
} as const;
export type ActionName = keyof typeof actionSchemas;
export type ActionInput<A extends ActionName> = z.infer<typeof actionSchemas[A]>;
export interface ActionOutputs {
  'connection.status': ConnectionView; 'connection.check': ConnectionView; 'connection.refresh': ConnectionView; 'connection.logout': ConnectionView;
  'connection.selectRoute': ConnectionView; 'connection.testRoute': RouteCheckView; 'sync.start': JobView | null; 'sync.status': JobView;
  'ledger.options': LedgerOptions; 'ledger.list': BillPage; 'ledger.detail': BillDetail; 'ledger.calendar': CalendarView; 'ledger.statistics': StatisticsView;
  'operations.get': OperationView; 'operations.reconcile': OperationView; 'capabilities.list': CapabilityView[];
  'ledger.create': OperationView; 'ledger.edit': OperationView; 'ledger.delete': OperationView; 'ledger.draft.get': BillDraftView | null; 'ledger.draft.save': BillDraftView;
  'ledger.transfer': OperationView; 'ledger.repayCard': OperationView; 'ledger.transfer.preview': TransferPreview; 'ledger.transfer.options': TransferOptions;
  'ledger.refund': OperationView;
  'ledger.reimburse': OperationView; 'ledger.cancelReimbursement': OperationView; 'ledger.setReimbursable': OperationView; 'ledger.reimbursement.members': ReimbursementMembers;
}
export interface ActionDefinition { title: string; description: string; kind: CapabilityView['kind']; evidence: CapabilityView['evidence']; requiresAccount: boolean; readOnly: boolean; destructive: boolean; unavailable?: { code: string; reason: string } }
const read = { kind: 'read', evidence: 'apk-static', requiresAccount: true, readOnly: true, destructive: false } as const;
const connection = { ...read, kind: 'connection', requiresAccount: false } as const;
const write = { ...read, kind: 'write', readOnly: false, unavailable: { code: 'WRITE_LIVE_UNVERIFIED', reason: '账单写入已完成契约与模拟测试，待专用测试账本真实验收后启用' } } as const;
export const actionDefinitions: Record<ActionName, ActionDefinition> = {
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
  'ledger.draft.get': { ...read, evidence: 'local', title: '读取账单草稿', description: '读取本账号的本地账单草稿和同一请求键已产生的operationId，不请求钱迹。' },
  'ledger.draft.save': { ...read, readOnly: false, evidence: 'local', title: '保存账单草稿', description: '只保存结构化本地草稿，不上传账单。已有未核清操作时不能替换草稿或请求键。' },
  'operations.get': { ...read, kind: 'reconciliation', title: '查看写操作结果', description: '读取操作日志、逐项结果及确定性，不发送写入。' },
  'operations.reconcile': { ...read, kind: 'reconciliation', title: '核查未知写入结果', description: '通过只读上游查询核查原操作，绝不重发已发送写入。' },
  'capabilities.list': { ...read, evidence: 'local', requiresAccount: false, title: '查看可用功能', description: '读取当前连接下各动作的证据阶段、可用性与不可用原因。模拟测试成功不代表真实验收通过。' },
};
export const actionRequestSchema = z.strictObject({ action: z.string().min(1).max(100), input: z.unknown().default({}), meta: z.strictObject({ requestId: id.optional() }).default({}) });
