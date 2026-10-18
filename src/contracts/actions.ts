import { z } from 'zod';
import { billFilterSchema, statisticsInputSchema } from '../features/ledger/contract';
import type { BillDetail, BillPage, CalendarView, StatisticsView, LedgerOptions } from '../features/ledger/contract';
import type { ConnectionView, RouteCheckView } from '../features/connection/contract';
import { syncInputSchema, type JobView } from '../features/sync/contract';
import type { OperationView } from '../operations/contract';
import type { CapabilityView } from './capabilities';
const empty = z.strictObject({}), id = z.string().min(1).max(200);
const route = z.strictObject({ route: z.enum(['main', 'backup', 'overseas']) });
export const actionSchemas = {
  'connection.status': empty, 'connection.check': empty, 'connection.refresh': empty, 'connection.logout': empty,
  'connection.selectRoute': route, 'connection.testRoute': route,
  'sync.start': syncInputSchema, 'sync.status': z.strictObject({ jobId: id }),
  'ledger.options': empty, 'ledger.list': billFilterSchema, 'ledger.detail': z.strictObject({ id }),
  'ledger.calendar': z.strictObject({ year: z.int().min(1).max(9999), month: z.int().min(1).max(12), filter: billFilterSchema.optional(), cursor: z.string().max(4096).optional() }),
  'ledger.statistics': statisticsInputSchema, 'operations.get': z.strictObject({ operationId: id }), 'operations.reconcile': z.strictObject({ operationId: id }), 'capabilities.list': empty,
} as const;
export type ActionName = keyof typeof actionSchemas;
export type ActionInput<A extends ActionName> = z.infer<typeof actionSchemas[A]>;
export interface ActionOutputs {
  'connection.status': ConnectionView; 'connection.check': ConnectionView; 'connection.refresh': ConnectionView; 'connection.logout': ConnectionView;
  'connection.selectRoute': ConnectionView; 'connection.testRoute': RouteCheckView; 'sync.start': JobView | null; 'sync.status': JobView;
  'ledger.options': LedgerOptions; 'ledger.list': BillPage; 'ledger.detail': BillDetail; 'ledger.calendar': CalendarView; 'ledger.statistics': StatisticsView;
  'operations.get': OperationView; 'operations.reconcile': OperationView; 'capabilities.list': CapabilityView[];
}
export interface ActionDefinition { title: string; description: string; kind: CapabilityView['kind']; evidence: CapabilityView['evidence']; requiresAccount: boolean; readOnly: boolean; destructive: boolean; unavailable?: { code: string; reason: string } }
const read = { kind: 'read', evidence: 'apk-static', requiresAccount: true, readOnly: true, destructive: false } as const;
const connection = { ...read, kind: 'connection', requiresAccount: false } as const;
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
  'operations.get': { ...read, kind: 'reconciliation', title: '查看写操作结果', description: '读取操作日志、逐项结果及确定性，不发送写入。' },
  'operations.reconcile': { ...read, kind: 'reconciliation', title: '核查未知写入结果', description: '通过只读上游查询核查原操作，绝不重发已发送写入。' },
  'capabilities.list': { ...read, evidence: 'local', requiresAccount: false, title: '查看可用功能', description: '读取当前连接下各动作的证据阶段、可用性与不可用原因。模拟测试成功不代表真实验收通过。' },
};
export const actionRequestSchema = z.strictObject({ action: z.string().min(1).max(100), input: z.unknown().default({}), meta: z.strictObject({ requestId: id.optional() }).default({}) });
