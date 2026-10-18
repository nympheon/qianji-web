import { z } from 'zod';
import type { Freshness, Id, Money, TimeRange } from '../../shared/model';
import type { StatSummary } from './statistics';

const id = z.string().min(1).max(200), ids = z.array(id).max(100);
const money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
export const dateFilterSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('day'), date: z.string() }),
  z.strictObject({ kind: z.literal('month'), year: z.int(), month: z.int().min(1).max(12) }),
  z.strictObject({ kind: z.literal('year'), year: z.int() }),
  z.strictObject({ kind: z.literal('range'), from: z.string(), to: z.string() }),
  z.strictObject({ kind: z.literal('today') }), z.strictObject({ kind: z.literal('this-month') }), z.strictObject({ kind: z.literal('this-year') }),
]);
export const billFilterSchema = z.strictObject({
  bookIds: ids.optional(), includeHiddenBooks: z.boolean().optional(), date: dateFilterSchema.optional(), zone: z.string().max(100).optional(),
  types: z.array(z.int()).max(50).optional(), amount: z.strictObject({ min: money.optional(), max: money.optional() }).optional(),
  categoryIds: ids.optional(), includeSubcategories: z.boolean().optional(), memberIds: ids.optional(),
  tagIds: ids.optional(), tagMatch: z.enum(['any', 'all']).optional(), hasTags: z.boolean().optional(),
  assetIds: ids.optional(), remark: z.string().max(500).optional(), sourcePlatforms: z.array(z.int()).max(50).optional(), sourceText: z.string().max(500).optional(),
  hasImages: z.boolean().optional(), groupReimbursements: z.boolean().optional(), order: z.enum(['asc', 'desc']).optional(),
  limit: z.int().min(1).max(200).optional(), cursor: z.string().max(4096).optional(),
});
export type BillFilter = z.infer<typeof billFilterSchema>;
export interface HistoricalCurrency {
  srcSymbol: string | null; srcValue: Money; targetSymbol: string | null; targetValue: Money; baseSymbol: string | null; baseValue: Money;
}
export interface BillSummary {
  id: Id; bookId: Id; type: number; timeSec: number; money: Money; remark: string; categoryId: Id | null;
  memberId: Id | null; assetId: Id | null; fromId: Id | null; targetId: Id | null; tagIds: Id[]; images: string[];
  platform: number; fromAct: string | null; targetAct: string | null; description: string | null; packId: Id | null;
  flags: number; transferFee: Money; currency: HistoricalCurrency | null; unknownType: boolean;
  refundIds: Id[]; reimbursementIds: Id[]; refundSourceId: Id | null; reimbursementSourceId: Id | null;
  legacyRefund: { id: Id; money: Money } | null;
  legacyReimbursement: { marked: boolean; money: Money; timeSec: number | null; assetId: Id | null };
}
export interface BillDetail extends BillSummary {
  editVersion?: string;
  refunds: BillSummary[]; reimbursements: BillSummary[]; sources: BillSummary[];
  missingRelatedIds: Id[]; incompleteReasons: string[]; freshness: Freshness;
}
export type BillRow = { kind: 'bill'; bill: BillSummary }
  | { kind: 'reimbursement-group'; displayType: 22; packId: Id; memberIds: Id[]; members: BillSummary[]; continuedBefore: boolean; continuedAfter: boolean };
export interface BillPage {
  items: BillSummary[]; rows: BillRow[]; nextCursor: string | null; freshness: Freshness;
  range: TimeRange | null; incompleteReasons: string[]; continuationReason: 'page-limit' | 'scan-limit' | null;
}
export interface CalendarInput { year: number; month: number; filter?: BillFilter; cursor?: string }
export interface CalendarView {
  days: { date: string; count: number }[]; nextCursor: string | null; complete: boolean; freshness: Freshness; range: TimeRange;
}
export const statisticsInputSchema = z.strictObject({
  filter: billFilterSchema.omit({ cursor: true, limit: true, order: true, groupReimbursements: true }).optional(),
  currency: z.string().min(1).max(20), trend: z.enum(['day', 'month', 'year']).optional(),
  dimensions: z.array(z.enum(['category', 'category-tree', 'tag', 'member', 'asset', 'book'])).max(6).optional(), comparison: dateFilterSchema.optional(),
});
export type StatisticsInput = z.infer<typeof statisticsInputSchema>;
export interface StatisticsView {
  currency: Id; range: TimeRange | null; totals: StatSummary;
  groups: { dimension: NonNullable<StatisticsInput['dimensions']>[number]; overlapping: boolean; items: { key: Id; parentId: Id | null; totals: StatSummary }[] }[];
  trend: { period: string; totals: StatSummary }[];
  comparison: { range: TimeRange | null; totals: StatSummary } | null;
  freshness: Freshness; incompleteReasons: string[];
}
export interface LedgerOptions {
  books: { id: Id; name: string; visible: boolean }[];
  categories: { id: Id; name: string; parentId: Id | null }[];
  tags: { id: Id; name: string }[]; complete: boolean;
}
