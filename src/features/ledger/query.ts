import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { ActorScope, Clock, TimeRange } from '../../shared/model';
import { businessRange } from '../../shared/dates';
import { compareMoney, addMoney } from '../../shared/numbers';
import { DomainError } from '../../shared/errors';
import { parseWire } from '../../shared/wire-json';
import type { Repository } from '../../storage/database';
import type { BillFilter, BillRow, BillSummary } from './contract';
import { summarizeBill } from './model';

export interface LedgerCursor { v: 1; uid: string; epoch: string; dataset: string; revision: string; filter: string; time: number; key: string; lastPack: string | null; lastType: number | null }
type QueryRow = { id: string; id_sort_key: string; book_id: string; type: number; time_sec: number; money: string; raw: string };
export interface QueryPlan {
  filter: BillFilter; datasetId: string | null; revision: string; range: TimeRange | null; zone: string;
  limit: number; order: 'asc' | 'desc'; fingerprint: string; prefix: string; where: string; bindings: SqlStorageValue[];
}
const sorted = <T extends string | number>(values: T[] | undefined): T[] | undefined => values?.length ? [...new Set(values)].sort() : undefined;
export function businessDay(seconds: number, zone: string): string {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-GB-u-ca-iso8601', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new DomainError('INVALID_TIMEZONE', '时间区域无效'); }
  if (!Number.isFinite(new Date(seconds * 1000).getTime())) throw new DomainError('INVALID_BILL_DATE', '账单时间无法按日期显示');
  const parts = Object.fromEntries(format.formatToParts(seconds * 1000).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function nativeId(raw: string, path: string): string {
  return `(CASE WHEN json_type(${raw},'${path}')='text' THEN json_extract(${raw},'${path}') ELSE ${raw} -> '${path}' END)`;
}
export function parseLedgerCursor(text: string | undefined, scope: ActorScope): LedgerCursor | null {
  if (!text) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as LedgerCursor;
    if (value.v !== 1 || value.uid !== scope.uid || value.epoch !== scope.connectionEpoch || typeof value.dataset !== 'string'
      || typeof value.revision !== 'string' || typeof value.filter !== 'string' || typeof value.key !== 'string' || !Number.isSafeInteger(value.time)) throw new Error();
    return value;
  } catch { throw new DomainError('PAGE_CHANGED', '分页范围已变化，请从第一页重新读取'); }
}
function encodeCursor(value: LedgerCursor): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }

export function createQueryPlan(repository: Repository, scope: ActorScope, input: BillFilter, clock: Clock): QueryPlan {
  const filter: BillFilter = { ...input, bookIds: sorted(input.bookIds), categoryIds: sorted(input.categoryIds), memberIds: sorted(input.memberIds), tagIds: sorted(input.tagIds), assetIds: sorted(input.assetIds), types: sorted(input.types), sourcePlatforms: sorted(input.sourcePlatforms) };
  // Omitted and empty filters share one normalized key; public schemas still reject unknown fields.
  const dataset = repository.dataset(scope, 'ledger'), books = repository.dataset(scope, 'books');
  const selectedBooks = filter.bookIds ? ' AND id IN (SELECT value FROM json_each(?))' : '';
  const bookBindings: SqlStorageValue[] = [scope.uid, books?.id ?? 'unloaded', ...(filter.bookIds ? [JSON.stringify(filter.bookIds)] : [])];
  const config = repository.sql.exec<{ n: number; range: string | null }>(`SELECT COUNT(DISTINCT COALESCE(json_extract(raw,'$.config.range'),'')) AS n,MIN(json_extract(raw,'$.config.range')) AS range FROM resources WHERE uid=? AND domain='books' AND dataset_id=? AND kind='book'${selectedBooks}${filter.includeHiddenBooks ? '' : " AND COALESCE(json_extract(raw,'$.visible'),1)=1"}`, ...bookBindings).one();
  const match = config.n === 1 && config.range ? /^m(\d+)$/.exec(config.range) : null;
  const monthStartDay = match ? Number(match[1]) : 1;
  const zone = filter.zone ?? 'Asia/Shanghai';
  // Validate timezone even for an all-date query.
  const today = businessDay(Math.floor(clock.nowMs() / 1000), zone), [year, month] = today.split('-').map(Number) as [number, number, number];
  let date = filter.date;
  if (date?.kind === 'today') date = { kind: 'day', date: today };
  if (date?.kind === 'this-year') date = { kind: 'year', year };
  if (date?.kind === 'this-month') {
    let currentYear = year, currentMonth = month;
    if (clock.nowMs() / 1000 < businessRange({ kind: 'month', year, month }, { monthStartDay }, zone).startSec) {
      currentMonth--; if (currentMonth === 0) { currentMonth = 12; currentYear--; }
    }
    date = { kind: 'month', year: currentYear, month: currentMonth };
  }
  const range = date ? businessRange(date, { monthStartDay }, zone) : null;
  const order = filter.order ?? 'desc', limit = filter.limit ?? 50;
  const revision = `ledger:${dataset?.id ?? 'unloaded'}:${dataset?.revision ?? '0'}|books:${books?.id ?? 'unloaded'}:${books?.revision ?? '0'}`;
  const normalized = { bookIds: filter.bookIds ?? [], includeHiddenBooks: filter.includeHiddenBooks ?? false, range, zone,
    types: filter.types ?? [], amount: filter.amount ? { min: filter.amount.min === undefined ? null : addMoney(filter.amount.min), max: filter.amount.max === undefined ? null : addMoney(filter.amount.max) } : null,
    categoryIds: filter.categoryIds ?? [], includeSubcategories: filter.includeSubcategories ?? true, memberIds: filter.memberIds ?? [],
    tagIds: filter.tagIds ?? [], tagMatch: filter.tagMatch ?? 'any', hasTags: filter.hasTags ?? null, assetIds: filter.assetIds ?? [],
    remark: filter.remark ?? '', sourcePlatforms: filter.sourcePlatforms ?? [], sourceText: filter.sourceText ?? '', hasImages: filter.hasImages ?? null,
    groupReimbursements: filter.groupReimbursements ?? true, order, limit };
  if (filter.amount?.min !== undefined && filter.amount.max !== undefined && compareMoney(filter.amount.min, filter.amount.max) > 0) throw new DomainError('INVALID_MONEY_RANGE', '金额下限不能大于上限');
  const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  let prefix = ''; const clauses = ["b.uid=?", "b.domain='ledger'", 'b.dataset_id=?', 'b.status_code<>0'];
  const bindings: SqlStorageValue[] = [scope.uid, dataset?.id ?? 'unloaded'];
  const inIds = (column: string, values: (string | number)[] | undefined) => {
    if (values?.length) { clauses.push(`${column} IN (SELECT value FROM json_each(?))`); bindings.push(JSON.stringify(values)); }
  };
  inIds('b.book_id', filter.bookIds); inIds('b.type', filter.types); inIds('b.member_id', filter.memberIds); inIds('b.platform_code', filter.sourcePlatforms);
  if (range) { clauses.push('b.time_sec BETWEEN ? AND ?'); bindings.push(range.startSec, range.endSec); }
  if (!filter.includeHiddenBooks) {
    clauses.push("NOT EXISTS(SELECT 1 FROM resources hidden WHERE hidden.uid=b.uid AND hidden.domain='books' AND hidden.dataset_id=? AND hidden.kind='book' AND hidden.id=b.book_id AND COALESCE(json_extract(hidden.raw,'$.visible'),1)<>1)"); bindings.push(books?.id ?? 'unloaded');
  }
  if (filter.categoryIds?.length) {
    if (filter.includeSubcategories === false) inIds('b.category_id', filter.categoryIds);
    else {
      prefix = `WITH RECURSIVE selected_categories(id) AS (SELECT value FROM json_each(?) UNION SELECT c.id FROM resources c JOIN selected_categories p ON ${nativeId('c.raw', '$.parentid')}=p.id WHERE c.uid=? AND c.domain='ledger' AND c.dataset_id=? AND c.kind='category') `;
      bindings.unshift(JSON.stringify(filter.categoryIds), scope.uid, dataset?.id ?? 'unloaded');
      clauses.push('b.category_id IN (SELECT id FROM selected_categories)');
    }
  }
  if (filter.assetIds?.length) {
    clauses.push('(b.asset_id IN (SELECT value FROM json_each(?)) OR b.from_id IN (SELECT value FROM json_each(?)) OR b.target_id IN (SELECT value FROM json_each(?)))');
    bindings.push(...Array(3).fill(JSON.stringify(filter.assetIds)) as string[]);
  }
  if (filter.remark) { clauses.push('instr(LOWER(b.remark_text),LOWER(?))>0'); bindings.push(filter.remark); }
  if (filter.sourceText) { clauses.push('instr(LOWER(b.source_text),LOWER(?))>0'); bindings.push(filter.sourceText); }
  if (filter.hasImages !== undefined) clauses.push(`COALESCE(json_array_length(b.raw,'$.images'),0)${filter.hasImages ? '>' : '='}0`);
  const tagArray = "CASE WHEN json_type(b.extra_json,'$.tags')='array' THEN b.extra_json -> '$.tags' ELSE '[]' END";
  if (filter.hasTags !== undefined) clauses.push(`json_array_length(${tagArray})${filter.hasTags ? '>' : '='}0`);
  if (filter.tagIds?.length) {
    const tagId = `(CASE WHEN t.type='text' THEN t.value ELSE (${tagArray}) -> ('$[' || t.key || ']') END)`;
    clauses.push(`(SELECT COUNT(DISTINCT ${tagId}) FROM json_each(${tagArray}) t WHERE ${tagId} IN (SELECT value FROM json_each(?)))${filter.tagMatch === 'all' ? '=?' : '>0'}`);
    bindings.push(JSON.stringify(filter.tagIds)); if (filter.tagMatch === 'all') bindings.push(filter.tagIds.length);
  }
  return { filter, datasetId: dataset?.id ?? null, revision, range, zone, limit, order, fingerprint, prefix, where: clauses.join(' AND '), bindings };
}

export function scanBillPage(repository: Repository, scope: ActorScope, plan: QueryPlan, cursor: LedgerCursor | null) {
  if (cursor && (cursor.dataset !== plan.datasetId || cursor.revision !== plan.revision || cursor.filter !== plan.fingerprint)) throw new DomainError('PAGE_CHANGED', '列表资料或筛选已变化，请重新读取第一页');
  const items: BillSummary[] = [], positions: { time: number; key: string }[] = [];
  let position = cursor ? { time: cursor.time, key: cursor.key } : null;
  let scanned = 0, ended = plan.datasetId === null;
  const direction = plan.order === 'asc' ? 'ASC' : 'DESC', comparison = plan.order === 'asc' ? '>' : '<';
  while (!ended && scanned < 5000 && items.length <= plan.limit) {
    const budget = Math.min(256, 5000 - scanned), conditions = position ? ` AND (b.time_sec${comparison}? OR (b.time_sec=? AND b.id_sort_key${comparison}?))` : '';
    const rows: QueryRow[] = repository.sql.exec<QueryRow>(`${plan.prefix}SELECT b.id,b.id_sort_key,b.book_id,b.type,b.time_sec,b.money,b.raw FROM bills b WHERE ${plan.where}${conditions} ORDER BY b.time_sec ${direction},b.id_sort_key ${direction} LIMIT ?`, ...plan.bindings, ...(position ? [position.time, position.time, position.key] : []), budget).toArray();
    if (rows.length === 0) { ended = true; break; }
    for (const row of rows) {
      scanned++; position = { time: row.time_sec, key: row.id_sort_key };
      if (plan.filter.amount?.min !== undefined && compareMoney(row.money, plan.filter.amount.min) < 0) continue;
      if (plan.filter.amount?.max !== undefined && compareMoney(row.money, plan.filter.amount.max) > 0) continue;
      items.push(summarizeBill({ id: row.id, bookId: row.book_id, type: row.type, timeSec: row.time_sec, money: row.money, raw: parseWire(row.raw), relations: [] }));
      positions.push(position);
      if (items.length > plan.limit) break;
    }
    if (items.length > plan.limit) break;
    if (rows.length < budget) ended = true;
  }
  const lookahead = items.length > plan.limit ? items.pop()! : null;
  if (lookahead) positions.pop();
  const hasMore = lookahead !== null || !ended;
  const nextPosition = lookahead ? positions.at(-1)! : position;
  const last = items.at(-1);
  const nextCursor = hasMore && nextPosition && plan.datasetId ? encodeCursor({ v: 1, uid: scope.uid, epoch: scope.connectionEpoch, dataset: plan.datasetId, revision: plan.revision, filter: plan.fingerprint,
    time: nextPosition.time, key: nextPosition.key, lastPack: last?.packId ?? cursor?.lastPack ?? null, lastType: last?.type ?? cursor?.lastType ?? null }) : null;
  return { items, lookahead, nextCursor, continuationReason: !hasMore ? null : lookahead ? 'page-limit' as const : 'scan-limit' as const };
}

export function billRows(items: BillSummary[], enabled: boolean, cursor: LedgerCursor | null, lookahead: BillSummary | null): BillRow[] {
  const rows: BillRow[] = [];
  for (let index = 0; index < items.length;) {
    const first = items[index]!;
    let end = index + 1;
    if (enabled && first.type === 21 && first.packId !== null) while (end < items.length && items[end]!.type === 21 && items[end]!.packId === first.packId) end++;
    const members = items.slice(index, end);
    if (members.length > 1) rows.push({ kind: 'reimbursement-group', displayType: 22, packId: first.packId!, members, memberIds: members.map((item) => item.id),
      continuedBefore: index === 0 && cursor?.lastType === 21 && cursor.lastPack === first.packId,
      continuedAfter: end === items.length && lookahead?.type === 21 && lookahead.packId === first.packId });
    else rows.push({ kind: 'bill', bill: first });
    index = end;
  }
  return rows;
}
