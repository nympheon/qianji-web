import { actionDefinitions, actionSchemas, type ActionName } from '../contracts/actions';
import type { AppReply } from '../shared/reply';
import { DomainError } from '../shared/errors';
import { listCapabilities } from './capabilities';
import { useCase, type UseCase, type UseCaseContext } from './use-case';

function scope(context: UseCaseContext) { const scope = context.connection.scope(); if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
const handlers: Record<ActionName, UseCase> = {
  'savings.list': useCase('savings.list', (ctx, input) => ctx.savings.list(input)), 'savings.project': useCase('savings.project', (ctx, input) => ctx.savings.project(input)),
  'savings.submit': useCase('savings.submit', (ctx, { requestId, ...input }) => ctx.savings.mutate('savings.submit', input, { requestId })),
  'savings.deposit': useCase('savings.deposit', (ctx, { requestId, ...input }) => ctx.savings.mutate('savings.deposit', input, { requestId })),
  'savings.cancelDeposit': useCase('savings.cancelDeposit', (ctx, { requestId, ...input }) => ctx.savings.mutate('savings.cancelDeposit', input, { requestId })),
  'savings.delete': useCase('savings.delete', (ctx, { requestId, ...input }) => ctx.savings.mutate('savings.delete', input, { requestId })),
  'savings.reorder': useCase('savings.reorder', (ctx, { requestId, ...input }) => ctx.savings.mutate('savings.reorder', input, { requestId })),
  'savings.draft.get': useCase('savings.draft.get', (ctx, input) => ctx.savings.getDraft(input.key)), 'savings.draft.save': useCase('savings.draft.save', (ctx, input) => ctx.savings.saveDraft(input.key, input.draft)),
  'installments.list': useCase('installments.list', (ctx, input) => ctx.installments.list(input)), 'installments.preview': useCase('installments.preview', (ctx, input) => ctx.installments.preview(input)),
  'installments.create': useCase('installments.create', (ctx, { requestId, ...input }) => ctx.installments.mutate('installments.create', input, { requestId })),
  'installments.configure': useCase('installments.configure', (ctx, { requestId, ...input }) => ctx.installments.mutate('installments.configure', input, { requestId })),
  'installments.prepay': useCase('installments.prepay', (ctx, { requestId, ...input }) => ctx.installments.mutate('installments.prepay', input, { requestId })),
  'installments.setBillBinding': useCase('installments.setBillBinding', (ctx, { requestId, ...input }) => ctx.installments.mutate('installments.setBillBinding', input, { requestId })),
  'installments.delete': useCase('installments.delete', (ctx, { requestId, ...input }) => ctx.installments.mutate('installments.delete', input, { requestId })),
  'installments.draft.get': useCase('installments.draft.get', (ctx, input) => ctx.installments.getDraft(input.key)), 'installments.draft.save': useCase('installments.draft.save', (ctx, input) => ctx.installments.saveDraft(input.key, input.draft)),
  'repeat.list': useCase('repeat.list', (ctx, input) => ctx.repeat.list(input)), 'repeat.preview': useCase('repeat.preview', (ctx, input) => ctx.repeat.preview(input)),
  'repeat.submit': useCase('repeat.submit', (ctx, { requestId, ...input }) => ctx.repeat.mutate('repeat.submit', input, { requestId })),
  'repeat.setPaused': useCase('repeat.setPaused', (ctx, { requestId, ...input }) => ctx.repeat.mutate('repeat.setPaused', input, { requestId })),
  'repeat.setBillBinding': useCase('repeat.setBillBinding', (ctx, { requestId, ...input }) => ctx.repeat.mutate('repeat.setBillBinding', input, { requestId })),
  'repeat.delete': useCase('repeat.delete', (ctx, { requestId, ...input }) => ctx.repeat.mutate('repeat.delete', input, { requestId })),
  'repeat.draft.get': useCase('repeat.draft.get', (ctx, input) => ctx.repeat.getDraft(input.key)), 'repeat.draft.save': useCase('repeat.draft.save', (ctx, input) => ctx.repeat.saveDraft(input.key, input.draft)),

  'categories.submit': useCase('categories.submit', (ctx, { requestId, ...input }) => ctx.categories.submit(input, { requestId })),
  'categories.changeLevel': useCase('categories.changeLevel', (ctx, { requestId, ...input }) => ctx.categories.changeLevel(input, { requestId })),
  'categories.move': useCase('categories.move', (ctx, { requestId, ...input }) => ctx.categories.move(input, { requestId })),
  'categories.reorder': useCase('categories.reorder', (ctx, { requestId, ...input }) => ctx.categories.reorder(input, { requestId })),
  'categories.delete': useCase('categories.delete', (ctx, { requestId, ...input }) => ctx.categories.remove(input, { requestId })),
  'categories.draft.get': useCase('categories.draft.get', (ctx, input) => ctx.categories.getDraft(input.key)), 'categories.draft.save': useCase('categories.draft.save', (ctx, input) => ctx.categories.saveDraft(input.key, input.draft)),
  'attachments.draft.applied': useCase('attachments.draft.applied', (ctx, input) => ctx.attachments.markApplied(input.key, input.operationId)),
  'attachments.draft.get': useCase('attachments.draft.get', (ctx, input) => ctx.attachments.getDraft(input.key)), 'attachments.draft.save': useCase('attachments.draft.save', (ctx, input) => ctx.attachments.saveDraft(input.key, input.draft)),
  'attachments.options': useCase('attachments.options', (ctx) => ctx.attachments.options()), 'attachments.resolve': useCase('attachments.resolve', (ctx, input) => ctx.attachments.resolve(input)), 'attachments.result': useCase('attachments.result', (ctx, input) => ctx.attachments.result(input.operationId)), 'attachments.upload': useCase('attachments.upload', (ctx, { requestId, ...input }) => ctx.attachments.upload(input, { requestId })),
  'budget.list': useCase('budget.list', (ctx, input) => ctx.budget.list(input)), 'budget.submit': useCase('budget.submit', (ctx, { requestId, ...input }) => ctx.budget.submit(input, { requestId })),
  'budget.draft.get': useCase('budget.draft.get', (ctx, input) => ctx.budget.getDraft(input.key)), 'budget.draft.save': useCase('budget.draft.save', (ctx, input) => ctx.budget.saveDraft(input.key, input.draft)),
  'tags.list': useCase('tags.list', (ctx, input) => ctx.tags.list(input)),
  'tags.submitTag': useCase('tags.submitTag', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.submitTag', input, { requestId })),
  'tags.submitGroup': useCase('tags.submitGroup', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.submitGroup', input, { requestId })),
  'tags.reorderTags': useCase('tags.reorderTags', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.reorderTags', input, { requestId })),
  'tags.reorderGroups': useCase('tags.reorderGroups', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.reorderGroups', input, { requestId })),
  'tags.setArchived': useCase('tags.setArchived', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.setArchived', input, { requestId })),
  'tags.deleteTag': useCase('tags.deleteTag', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.deleteTag', input, { requestId })),
  'tags.deleteGroup': useCase('tags.deleteGroup', (ctx, { requestId, ...input }) => ctx.tags.mutate('tags.deleteGroup', input, { requestId })),
  'tags.draft.get': useCase('tags.draft.get', (ctx, input) => ctx.tags.getDraft(input.key)), 'tags.draft.save': useCase('tags.draft.save', (ctx, input) => ctx.tags.saveDraft(input.key, input.draft)),
  'categories.list': useCase('categories.list', (ctx, input) => ctx.categories.list(input)), 'categories.checkDelete': useCase('categories.checkDelete', (ctx, input) => ctx.categories.checkDelete(input)),
  'books.list': useCase('books.list', (ctx, input) => ctx.books.list(input)), 'books.types': useCase('books.types', (ctx) => ctx.books.types()), 'books.members': useCase('books.members', (ctx, input) => ctx.books.members(input.id)), 'books.deleteCheck': useCase('books.deleteCheck', (ctx, input) => ctx.books.checkDelete(input.id)), 'books.accounting': useCase('books.accounting', (ctx) => ctx.books.accounting()),
  'books.submit': useCase('books.submit', (ctx, { requestId, ...input }) => ctx.books.submit(input, { requestId })), 'books.configure': useCase('books.configure', (ctx, { requestId, ...input }) => ctx.books.configure(input, { requestId })),
  'books.setVisible': useCase('books.setVisible', (ctx, { requestId, ...input }) => ctx.books.setVisible(input, { requestId })), 'books.delete': useCase('books.delete', (ctx, { requestId, ...input }) => ctx.books.remove(input, { requestId })), 'books.quit': useCase('books.quit', (ctx, { requestId, ...input }) => ctx.books.quit(input, { requestId })), 'books.reorder': useCase('books.reorder', (ctx, { requestId, ...input }) => ctx.books.reorder(input, { requestId })), 'books.setBaseCurrency': useCase('books.setBaseCurrency', (ctx, { requestId, ...input }) => ctx.books.setBaseCurrency(input, { requestId })),
  'books.draft.get': useCase('books.draft.get', (ctx, input) => ctx.books.getDraft(input.key)), 'books.draft.save': useCase('books.draft.save', (ctx, input) => ctx.books.saveDraft(input.key, input.draft)),
  'debt.list': useCase('debt.list', (ctx, input) => ctx.debt.list(input)), 'debt.options': useCase('debt.options', (ctx) => ctx.debt.options()),
  'debt.preview': useCase('debt.preview', (ctx, input) => ctx.debt.preview(input.action, input.input)),
  'debt.create': useCase('debt.create', (ctx, { requestId, ...input }) => ctx.debt.create(input, { requestId })),
  'debt.appendPrincipal': useCase('debt.appendPrincipal', (ctx, { requestId, ...input }) => ctx.debt.appendPrincipal(input, { requestId })),
  'debt.editPrincipal': useCase('debt.editPrincipal', (ctx, { requestId, ...input }) => ctx.debt.editPrincipal(input, { requestId })),
  'debt.pay': useCase('debt.pay', (ctx, { requestId, ...input }) => ctx.debt.pay(input, { requestId })),
  'debt.draft.get': useCase('debt.draft.get', (ctx, input) => ctx.debt.getDraft(input.key)), 'debt.draft.save': useCase('debt.draft.save', (ctx, input) => ctx.debt.saveDraft(input.key, input.draft)),
  'connection.status': useCase('connection.status', (ctx) => ctx.connection.view()),
  'connection.check': useCase('connection.check', (ctx) => ctx.connection.check()),
  'connection.refresh': useCase('connection.refresh', (ctx) => ctx.connection.refresh()),
  'connection.logout': useCase('connection.logout', (ctx) => ctx.connection.logout()),
  'connection.selectRoute': useCase('connection.selectRoute', (ctx, input) => ctx.connection.selectRoute(input.route)),
  'connection.testRoute': useCase('connection.testRoute', (ctx, input) => ctx.connection.testRoute(input.route)),
  'sync.start': useCase('sync.start', async (ctx, input) => input.mode === 'rebuild' ? ctx.sync.start(input) : (await ctx.freshness.ensureFresh(scope(ctx), [input.domain], 'manual-incremental')).job),
  'sync.status': useCase('sync.status', (ctx, input) => ctx.rebuild.getJob(scope(ctx), input.jobId) ?? ctx.sync.getJob(scope(ctx), input.jobId)),
  'ledger.list': useCase('ledger.list', (ctx, input) => ctx.ledger.list(input)),
  'ledger.options': useCase('ledger.options', (ctx) => ctx.ledger.options()),
  'ledger.detail': useCase('ledger.detail', (ctx, input) => ctx.ledger.detail(input.id)),
  'ledger.calendar': useCase('ledger.calendar', (ctx, input) => ctx.ledger.calendar({ year: input.year, month: input.month, ...(input.filter ? { filter: input.filter } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) })),
  'ledger.statistics': useCase('ledger.statistics', (ctx, input) => ctx.ledger.statistics(input)),
  'ledger.create': useCase('ledger.create', (ctx, input) => ctx.ledger.create({ bills: input.bills }, { requestId: input.requestId })),
  'ledger.edit': useCase('ledger.edit', (ctx, input) => ctx.ledger.edit({ bills: input.bills }, { requestId: input.requestId })),
  'ledger.delete': useCase('ledger.delete', (ctx, input) => ctx.ledger.remove({ bills: input.bills }, { requestId: input.requestId })),
  'ledger.transfer': useCase('ledger.transfer', (ctx, { requestId, ...input }) => ctx.ledger.transfer(input, { requestId })),
  'ledger.repayCard': useCase('ledger.repayCard', (ctx, { requestId, ...input }) => ctx.ledger.repayCard(input, { requestId })),
  'ledger.refund': useCase('ledger.refund', (ctx, { requestId, ...input }) => ctx.ledger.refund(input, { requestId })),
  'ledger.reimburse': useCase('ledger.reimburse', (ctx, { requestId, ...input }) => ctx.ledger.reimburse(input, { requestId })),
  'ledger.cancelReimbursement': useCase('ledger.cancelReimbursement', (ctx, { requestId, ...input }) => ctx.ledger.cancelReimbursement(input, { requestId })),
  'ledger.setReimbursable': useCase('ledger.setReimbursable', (ctx, { requestId, ...input }) => ctx.ledger.setReimbursable(input, { requestId })),
  'ledger.reimbursement.members': useCase('ledger.reimbursement.members', (ctx, input) => ctx.ledger.reimbursementMembers(input.packId)),
  'ledger.transfer.preview': useCase('ledger.transfer.preview', (ctx, input) => ctx.ledgerWrites.previewTransfer(input.kind, input.input)),
  'ledger.transfer.options': useCase('ledger.transfer.options', (ctx) => ctx.ledgerWrites.transferOptions()),
  'assets.list': useCase('assets.list', (ctx, input) => ctx.assets.list(input)), 'assets.detail': useCase('assets.detail', (ctx, input) => ctx.assets.detail(input.id)),
  'assets.summary': useCase('assets.summary', (ctx, input) => ctx.assets.summary(input)),
  'assets.types': useCase('assets.types', (ctx) => ctx.assets.types()), 'assets.groups.list': useCase('assets.groups.list', (ctx) => ctx.assets.groups()), 'assets.trend': useCase('assets.trend', (ctx, input) => ctx.assets.trend(input)),
  'assets.deleteCheck': useCase('assets.deleteCheck', (ctx, input) => ctx.assets.checkDelete(input.id)),
  'assets.submit': useCase('assets.submit', (ctx, { requestId, ...input }) => ctx.assets.submit(input, { requestId })),
  'assets.adjustBalance': useCase('assets.adjustBalance', (ctx, { requestId, ...input }) => ctx.assets.adjustBalance(input, { requestId })),
  'assets.setFinished': useCase('assets.setFinished', (ctx, { requestId, ...input }) => ctx.assets.setFinished(input, { requestId })),
  'assets.setVisible': useCase('assets.setVisible', (ctx, { requestId, ...input }) => ctx.assets.setVisible(input, { requestId })),
  'assets.reorder': useCase('assets.reorder', (ctx, { requestId, ...input }) => ctx.assets.reorder(input, { requestId })),
  'assets.delete': useCase('assets.delete', (ctx, { requestId, ...input }) => ctx.assets.remove(input, { requestId })),
  'assets.groups.submit': useCase('assets.groups.submit', (ctx, { requestId, ...input }) => ctx.assets.submitGroup(input, { requestId })),
  'assets.groups.delete': useCase('assets.groups.delete', (ctx, { requestId, ...input }) => ctx.assets.removeGroup(input, { requestId })),
  'assets.groups.reorder': useCase('assets.groups.reorder', (ctx, { requestId, ...input }) => ctx.assets.reorderGroups(input, { requestId })),
  'assets.groups.add': useCase('assets.groups.add', (ctx, { requestId, ...input }) => ctx.assets.addToGroup(input, { requestId })),
  'assets.groups.remove': useCase('assets.groups.remove', (ctx, { requestId, ...input }) => ctx.assets.removeFromGroup(input, { requestId })),
  'assets.draft.get': useCase('assets.draft.get', (ctx, input) => ctx.assets.getDraft(input.key)),
  'assets.draft.save': useCase('assets.draft.save', (ctx, input) => ctx.assets.saveDraft(input.key, input.draft)),
  'ledger.draft.get': useCase('ledger.draft.get', (ctx, input) => ctx.ledgerWrites.getDraft(input.key)),
  'ledger.draft.save': useCase('ledger.draft.save', (ctx, input) => ctx.ledgerWrites.saveDraft(input.key, input.draft)),
  'operations.get': useCase('operations.get', (ctx, input) => ctx.coordinator.getOperation(scope(ctx), input.operationId)),
  'operations.reconcile': useCase('operations.reconcile', (ctx, input) => ctx.coordinator.reconcileOperation(scope(ctx), input.operationId)),
  'capabilities.list': useCase('capabilities.list', (ctx) => listCapabilities(ctx)),
};
export class AppRegistry {
  constructor(private readonly context: UseCaseContext) {}
  private currentJob() {
    const ctx = this.context, current = ctx.connection.scope(); if (!current) return null;
    const parent = ctx.repository.sql.exec<{ id: string }>("SELECT id FROM rebuild_jobs WHERE uid=? AND connection_epoch=? AND state='running' AND EXISTS(SELECT 1 FROM json_each(rebuild_jobs.domains) WHERE value='ledger') ORDER BY rowid DESC LIMIT 1", current.uid, current.connectionEpoch).toArray()[0];
    if (parent) return ctx.rebuild.getJob(current, parent.id);
    const job = ctx.repository.sql.exec<{ id: string }>("SELECT id FROM sync_jobs WHERE uid=? AND connection_epoch=? AND domain='ledger' AND state='running' ORDER BY rowid DESC LIMIT 1", current.uid, current.connectionEpoch).toArray()[0];
    return job ? ctx.sync.getJob(current, job.id) : null;
  }
  async invoke(name: string, input: unknown, _meta: unknown = {}): Promise<AppReply<unknown>> {
    try {
      if (!Object.hasOwn(handlers, name)) throw new DomainError('ACTION_NOT_FOUND', '该操作不存在');
      const action = name as ActionName, definition = actionDefinitions[action];
      if (!actionSchemas[action].safeParse(input).success) throw new DomainError('INVALID_ACTION_INPUT', '操作参数无效，请检查筛选或输入');
      if (definition.unavailable) return { status: 'unavailable', data: null, freshness: null, error: { code: definition.unavailable.code, message: definition.unavailable.reason } };
      if (definition.requiresAccount && !this.context.connection.scope()) return { status: 'unavailable', data: { connectionUrl: '/connection' }, freshness: null, error: { code: 'CONNECTION_REQUIRED', message: '请先打开连接页面登录钱迹' } };
      if (action === 'ledger.statistics') {
        const fresh = await this.context.freshness.ensureFresh(scope(this.context), ['ledger'], 'normal'), job = this.currentJob();
        if (job || !fresh.freshness.complete) return { status: job ? 'running' : 'partial', data: null, freshness: fresh.freshness, ...(job ? { jobId: job.id } : { error: { code: 'SOURCE_INCOMPLETE', message: '完整账单尚未就绪，请完成同步后重试统计' } }) };
      }
      const data = await handlers[action].invoke(this.context, input);
      if (data === null && ['sync.status', 'operations.get'].includes(action)) throw new DomainError('RESULT_NOT_FOUND', '任务或操作不存在');
      if (action === 'sync.start' || action === 'sync.status') {
        const job = data as Awaited<ReturnType<UseCaseContext['sync']['start']>> | null;
        return { status: job?.state === 'running' ? 'running' : job?.state === 'failed' ? 'error' : job?.state === 'truncated' ? 'partial' : 'ready', data, freshness: null, ...(job ? { jobId: job.id, ...(job.error ? { error: job.error } : {}) } : {}) };
      }
      if ((action.startsWith('operations.') || definition.kind === 'write') && data) {
        const operation = data as NonNullable<ReturnType<UseCaseContext['coordinator']['getOperation']>>;
        return { status: ['queued', 'sending', 'verifying'].includes(operation.state) ? 'running' : operation.state === 'uncertain' ? 'uncertain' : operation.state === 'partial' ? 'partial' : operation.state === 'failed' ? 'error' : 'ready', data, freshness: null, operationId: operation.id, ...(operation.error ? { error: operation.error } : {}) };
      }
      const freshness = data && typeof data === 'object' && 'freshness' in data ? (data as { freshness: AppReply<unknown>['freshness'] }).freshness : null;
      if ((action.startsWith('assets.') || action.startsWith('debt.') || action.startsWith('books.') || action.startsWith('categories.') || action.startsWith('tags.') || action.startsWith('budget.')) && data && typeof data === 'object' && 'problem' in data && data.problem && typeof data.problem === 'object' && 'code' in data.problem && 'message' in data.problem && typeof data.problem.code === 'string' && typeof data.problem.message === 'string') return { status: 'partial', data, freshness, error: { code: data.problem.code, message: data.problem.message } };
      const job = (action.startsWith('ledger.') || action === 'budget.list') ? this.currentJob() : null;
      return { status: job ? 'running' : freshness && !freshness.complete ? 'partial' : 'ready', data, freshness, ...(job ? { jobId: job.id } : {}) };
    } catch (error) {
      return { status: 'error', data: null, freshness: null, error: error instanceof DomainError ? { code: error.code, message: error.detail } : { code: 'ACTION_FAILED', message: '操作未能完成，请查看连接状态或稍后重试' } };
    }
  }
}
