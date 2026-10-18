import type { ActorScope, Clock, Freshness, Id } from '../../shared/model';
import type { Repository } from '../../storage/database';
import type { ConnectionService } from '../connection/service';
import type { FreshnessService } from '../sync/freshness';
import type { BillDetail, BillFilter, BillPage, BillSummary, CalendarInput, CalendarView, StatisticsInput, StatisticsView, LedgerOptions } from './contract';
import { billFilterSchema, statisticsInputSchema } from './contract';
import { DomainError } from '../../shared/errors';
import { billRows, businessDay, createQueryPlan, parseLedgerCursor, scanBillPage, type QueryPlan } from './query';
import { summarizeBill } from './model';
import { businessRange } from '../../shared/dates';
import { asBillObject, numericText, optionalWireId } from '../../shared/bill-wire';
import { parseWire } from '../../shared/wire-json';
import { aggregate, toStatItem } from './statistics';
import { statisticsDimensions } from './statistics-view';
import { billVersion } from './write';
import type { LedgerWriteService } from './write-service';
import type { CreateBillsInput, DeleteBillsInput, EditBillsInput } from './write-contract';
import type { TransferInput } from './transfer-contract';
import type { RefundInput } from './refund-contract';
import type { CancelReimbursementInput, ReimburseInput, ReimbursableInput, ReimbursementMembers } from './reimbursement-contract';
import { ResourceCache } from '../../storage/cache';
import { bookListKey } from '../books/source';

export interface LedgerDependencies { repository: Repository; connection: ConnectionService; freshness: FreshnessService; clock: Clock; baseCurrency?: () => Id; writes?: LedgerWriteService }
function hydrateBill(bill: BillSummary, read: (id: Id) => BillSummary | null, freshness: Freshness): BillDetail {
  const missing: Id[] = [];
  const load = (ids: Id[]) => ids.slice(0, 200).flatMap((id) => { const row = read(id); if (!row) { missing.push(id); return []; } return [row]; });
  const refunds = load(bill.refundIds), reimbursements = load(bill.reimbursementIds);
  const sources = load([...new Set([bill.refundSourceId, bill.reimbursementSourceId].filter((value): value is string => value !== null))]);
  const limited = bill.refundIds.length > 200 || bill.reimbursementIds.length > 200;
  return { ...bill, refunds, reimbursements, sources, missingRelatedIds: [...new Set(missing)], incompleteReasons: [...(missing.length ? ['RELATED_BILL_MISSING'] : []), ...(limited ? ['RELATED_LOOKUP_LIMIT'] : []), ...(bill.unknownType ? ['UNKNOWN_BILL_TYPE'] : [])],
    freshness: { ...freshness, complete: freshness.complete && missing.length === 0 && !limited && !bill.unknownType, stale: freshness.stale || missing.length > 0 || limited || bill.unknownType } };
}
export class LedgerService {
  readonly #statistics = new Map<string, Omit<StatisticsView, 'freshness'>>();
  constructor(private readonly dependencies: LedgerDependencies) {}
  private writes() { if (!this.dependencies.writes) throw new DomainError('ACTION_UNAVAILABLE', '账单写入尚不可用'); return this.dependencies.writes; }
  create(input: CreateBillsInput, meta: { requestId: string }) { return this.writes().create(input, meta); }
  edit(input: EditBillsInput, meta: { requestId: string }) { return this.writes().edit(input, meta); }
  remove(input: DeleteBillsInput, meta: { requestId: string }) { return this.writes().remove(input, meta); }
  transfer(input: TransferInput, meta: { requestId: string }) { return this.writes().transfer(input, meta); }
  repayCard(input: TransferInput, meta: { requestId: string }) { return this.writes().repayCard(input, meta); }
  refund(input: RefundInput, meta: { requestId: string }) { return this.writes().refund(input, meta); }
  reimburse(input: ReimburseInput, meta: { requestId: string }) { return this.writes().reimburse(input, meta); }
  cancelReimbursement(input: CancelReimbursementInput, meta: { requestId: string }) { return this.writes().cancelReimbursement(input, meta); }
  setReimbursable(input: ReimbursableInput, meta: { requestId: string }) { return this.writes().setReimbursable(input, meta); }
  async reimbursementMembers(packId: string): Promise<ReimbursementMembers> {
    if (!/^[1-9]\d{0,24}$/.test(packId)) throw new DomainError('INVALID_PACK_ID', '报销分组 ID 无效');
    const scope = this.scope(), fresh = await this.dependencies.freshness.ensureFresh(scope, ['ledger'], 'normal'), repo = this.dependencies.repository, dataset = repo.dataset(scope, 'ledger');
    const rows = repo.sql.exec<{ id: string }>("SELECT id FROM bills WHERE uid=? AND domain='ledger' AND dataset_id=? AND type=21 AND status_code<>0 AND (CASE WHEN json_type(raw,'$.packid')='text' THEN json_extract(raw,'$.packid') ELSE raw -> '$.packid' END)=? ORDER BY time_sec,id_sort_key LIMIT 201", scope.uid, dataset?.id ?? 'unloaded', packId).toArray();
    const items = rows.slice(0, 200).map(({ id }) => { const record = repo.readBill(scope, id)!; return { ...hydrateBill(summarizeBill(record), (id) => { const row = repo.readBill(scope, id); return row ? summarizeBill(row) : null; }, fresh.freshness), editVersion: billVersion(record.raw) }; });
    const complete = fresh.freshness.complete && rows.length <= 200 && items.every((item) => item.freshness.complete);
    return { packId, items, complete, freshness: { ...fresh.freshness, complete, stale: fresh.freshness.stale || !complete } };
  }
  async statistics(input: StatisticsInput): Promise<StatisticsView> {
    const parsed = statisticsInputSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_STATISTICS_INPUT', '统计筛选参数无效');
    input = parsed.data;
    const scope = this.scope(), { repository, clock } = this.dependencies;
    const source = await this.dependencies.freshness.ensureFresh(scope, ['ledger'], 'normal');
    const filter = { ...input.filter, limit: 200, order: 'asc' as const, groupReimbursements: false };
    const plan = createQueryPlan(repository, scope, filter, clock);
    const comparison = input.comparison ? createQueryPlan(repository, scope, { ...filter, date: input.comparison }, clock) : null;
    const baseCurrency = this.dependencies.baseCurrency?.() ?? 'CNY';
    const key = JSON.stringify([scope.uid, scope.connectionEpoch, plan.revision, plan.fingerprint, comparison?.fingerprint, input.currency, baseCurrency, input.trend ?? 'day', [...new Set(input.dimensions ?? [])].sort()]);
    let result = this.#statistics.get(key);
    if (!result) {
      const current = this.collectStatistics(scope, plan, input.currency, baseCurrency, source.freshness);
      const previous = comparison ? this.collectStatistics(scope, comparison, input.currency, baseCurrency, source.freshness) : null;
      const parents = new Map<string, string | null>();
      if (plan.datasetId) for (const row of repository.sql.exec<{ id: string; raw: string }>("SELECT id,raw FROM resources WHERE uid=? AND domain='ledger' AND dataset_id=? AND kind='category'", scope.uid, plan.datasetId).toArray()) {
        parents.set(row.id, optionalWireId(asBillObject(parseWire(row.raw)).parentid));
      }
      const dimensions = statisticsDimensions(current.bills, current.items, input, parents, plan.zone);
      result = { currency: input.currency, range: plan.range, totals: aggregate(current.items), groups: dimensions.groups, trend: dimensions.trend,
        comparison: previous ? { range: comparison!.range, totals: aggregate(previous.items) } : null,
        incompleteReasons: [...new Set([...current.incompleteReasons, ...(previous?.incompleteReasons ?? []), ...dimensions.incompleteReasons])] };
      this.#statistics.set(key, result);
      if (this.#statistics.size > 8) this.#statistics.delete(this.#statistics.keys().next().value!);
    } else { this.#statistics.delete(key); this.#statistics.set(key, result); }
    const reasons = [...new Set([...result.incompleteReasons, ...(!source.freshness.complete ? ['SOURCE_INCOMPLETE'] : [])])];
    return { ...result, incompleteReasons: reasons, freshness: { ...source.freshness, revision: plan.revision, complete: source.freshness.complete && reasons.length === 0, stale: source.freshness.stale || reasons.length > 0 } };
  }
  private collectStatistics(scope: ActorScope, plan: QueryPlan, currency: Id, baseCurrency: Id, freshness: Freshness) {
    const bills: BillSummary[] = [], reasons = new Set<string>();
    let cursor = null, scanned = 0;
    do {
      const page = scanBillPage(this.dependencies.repository, scope, plan, cursor, 5000 - scanned);
      scanned += page.scanned; bills.push(...page.items);
      cursor = parseLedgerCursor(page.nextCursor ?? undefined, scope);
    } while (cursor && scanned < 5000);
    if (cursor) reasons.add('STATISTICS_SCAN_LIMIT');
    const memo = new Map<Id, BillSummary | null>(bills.map((bill) => [bill.id, bill]));
    const read = (id: Id) => {
      if (memo.has(id)) return memo.get(id)!;
      if (memo.size >= 10_000) { reasons.add('RELATED_LOOKUP_LIMIT'); return null; }
      const record = this.dependencies.repository.readBill(scope, id), bill = record ? summarizeBill(record) : null;
      memo.set(id, bill); return bill;
    };
    const items = bills.map((bill) => {
      const detail = hydrateBill(bill, read, freshness), item = toStatItem(detail, 'statistics', currency, baseCurrency);
      item.incompleteReasons.forEach((reason) => reasons.add(reason)); return item;
    });
    return { bills, items, incompleteReasons: [...reasons] };
  }
  private scope() {
    const scope = this.dependencies.connection.scope();
    if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹');
    return scope;
  }
  options(): LedgerOptions {
    const scope = this.scope(), repository = this.dependencies.repository;
    const books = repository.readResources(scope, 'book', { domain: 'books', limit: 200 });
    const categories = repository.readResources(scope, 'category', { domain: 'ledger', limit: 200 });
    const tags = repository.readResources(scope, 'tag', { domain: 'tags', limit: 200 });
    const hasBookSource = repository.sql.exec("SELECT 1 FROM source_queries WHERE uid=? AND domain='books' AND query_key=?", scope.uid, bookListKey.queryKey).toArray().length > 0;
    const booksComplete = hasBookSource ? new ResourceCache(repository, this.dependencies.clock).read(scope, bookListKey).complete : !!repository.dataset(scope, 'books')?.complete;
    const name = (raw: ReturnType<typeof asBillObject>, id: Id) => typeof raw.name === 'string' ? raw.name : id;
    return { baseCurrency: this.dependencies.baseCurrency?.() ?? 'CNY', books: books.items.map((item) => { const raw = asBillObject(item.raw); return { id: item.id, name: name(raw, item.id), visible: numericText(raw.visible, '1') === '1' }; }),
      categories: categories.items.map((item) => { const raw = asBillObject(item.raw); return { id: item.id, name: name(raw, item.id), parentId: optionalWireId(raw.parentid) }; }),
      tags: tags.items.map((item) => ({ id: item.id, name: name(asBillObject(item.raw), item.id) })),
      complete: !books.nextCursor && !categories.nextCursor && !tags.nextCursor && booksComplete && !!repository.dataset(scope, 'ledger')?.complete && !!repository.dataset(scope, 'tags')?.complete };
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
    return { ...hydrateBill(summarizeBill(record), (id) => {
      const row = this.dependencies.repository.readBill(scope, id); return row ? summarizeBill(row) : null;
    }, source.freshness), editVersion: billVersion(record.raw) };
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
