import type { Clock, Id } from '../../shared/model';
import type { Repository } from '../../storage/database';
import type { ConnectionService } from '../connection/service';
import type { FreshnessService } from '../sync/freshness';
import type { BillDetail, BillFilter, BillPage, CalendarInput, CalendarView } from './contract';
import { billFilterSchema } from './contract';
import { DomainError } from '../../shared/errors';
import { billRows, businessDay, createQueryPlan, parseLedgerCursor, scanBillPage } from './query';
import { summarizeBill } from './model';
import { businessRange } from '../../shared/dates';

export interface LedgerDependencies { repository: Repository; connection: ConnectionService; freshness: FreshnessService; clock: Clock }
export class LedgerService {
  constructor(private readonly dependencies: LedgerDependencies) {}
  private scope() {
    const scope = this.dependencies.connection.scope();
    if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹');
    return scope;
  }
  async list(input: BillFilter): Promise<BillPage> {
    const parsed = billFilterSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_BILL_FILTER', '账单筛选参数无效');
    const scope = this.scope(), cursor = parseLedgerCursor(input.cursor, scope);
    const source = await this.dependencies.freshness.ensureFresh(scope, ['ledger'], 'normal');
    const plan = createQueryPlan(this.dependencies.repository, scope, parsed.data, this.dependencies.clock);
    const page = scanBillPage(this.dependencies.repository, scope, plan, cursor);
    return { items: page.items, nextCursor: page.nextCursor, continuationReason: page.continuationReason, rows: billRows(page.items, input.groupReimbursements !== false, cursor, page.lookahead), range: plan.range,
      freshness: { ...source.freshness, revision: plan.revision }, incompleteReasons: page.items.some((item) => item.unknownType) ? ['UNKNOWN_BILL_TYPE'] : [] };
  }
  async detail(id: Id): Promise<BillDetail> {
    const scope = this.scope();
    const source = await this.dependencies.freshness.ensureFresh(scope, ['ledger'], 'normal');
    const record = this.dependencies.repository.readBill(scope, id);
    if (!record) throw new DomainError(source.freshness.complete ? 'BILL_NOT_FOUND' : 'BILL_NOT_LOADED', source.freshness.complete ? '账单不存在' : '账单尚未完整载入');
    const bill = summarizeBill(record), missing: Id[] = [];
    const load = (ids: Id[]) => ids.slice(0, 200).flatMap((id) => {
      const row = this.dependencies.repository.readBill(scope, id);
      if (!row) { missing.push(id); return []; }
      return [summarizeBill(row)];
    });
    const refunds = load(bill.refundIds), reimbursements = load(bill.reimbursementIds);
    const sources = load([...new Set([bill.refundSourceId, bill.reimbursementSourceId].filter((value): value is string => value !== null))]);
    const limited = bill.refundIds.length > 200 || bill.reimbursementIds.length > 200;
    return { ...bill, refunds, reimbursements, sources, missingRelatedIds: [...new Set(missing)], incompleteReasons: [...(missing.length ? ['RELATED_BILL_MISSING'] : []), ...(limited ? ['RELATED_LOOKUP_LIMIT'] : []), ...(bill.unknownType ? ['UNKNOWN_BILL_TYPE'] : [])],
      freshness: { ...source.freshness, complete: source.freshness.complete && missing.length === 0 && !limited && !bill.unknownType, stale: source.freshness.stale || missing.length > 0 || limited || bill.unknownType } };
  }
  async calendar(input: CalendarInput): Promise<CalendarView> {
    const zone = input.filter?.zone ?? 'Asia/Shanghai';
    const range = businessRange({ kind: 'month', year: input.year, month: input.month }, { monthStartDay: 1 }, zone);
    const first = businessDay(range.startSec, zone), last = businessDay(range.endSec, zone);
    const dayCount = Number(last.slice(8));
    const days = new Map(Array.from({ length: dayCount }, (_, day) => [`${first.slice(0, 8)}${String(day + 1).padStart(2, '0')}`, 0]));
    let cursor = input.cursor, next: BillPage | null = null;
    for (let iteration = 0; iteration < 25; iteration++) {
      next = await this.list({ ...input.filter, cursor, date: { kind: 'range', from: first, to: last }, groupReimbursements: false, limit: 200 });
      for (const item of next.items) { const day = businessDay(item.timeSec, zone); days.set(day, (days.get(day) ?? 0) + 1); }
      cursor = next.nextCursor ?? undefined; if (!cursor) break;
    }
    return { days: [...days].map(([date, count]) => ({ date, count })), nextCursor: cursor ?? null, complete: next!.freshness.complete && !cursor, freshness: next!.freshness, range };
  }
}
