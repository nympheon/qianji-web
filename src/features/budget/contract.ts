import type { BillDetail } from '../ledger/contract';
import type { Id, Money, TimeRange } from '../../shared/model';
import { z } from 'zod';
import { bookIdSchema, bookRangeSchema } from '../books/contract';
import { categoryIdSchema } from '../categories/contract';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
export const budgetQuerySchema = z.strictObject({ bookId: bookIdSchema, date: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('month'), year: z.int().min(1).max(9999), month: z.int().min(1).max(12) }), z.strictObject({ kind: z.literal('year'), year: z.int().min(1).max(9999) })]), range: bookRangeSchema.default(''), zone: z.string().min(1).max(100).default('Asia/Shanghai') });
const limit = z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d{1,10})?$/);
export const budgetChangesSchema = budgetQuerySchema.extend({ expectedVersion: z.string().length(64), changes: z.array(z.strictObject({ categoryId: categoryIdSchema.nullable(), limit })).min(1).max(500) }).refine((input) => new Set(input.changes.map((change) => change.categoryId)).size === input.changes.length, '同一分类预算不可重复');
export type BudgetQuery = z.infer<typeof budgetQuerySchema>;
export type BudgetQueryInput = z.input<typeof budgetQuerySchema>;
export type BudgetChangesInput = z.infer<typeof budgetChangesSchema>;
export interface BudgetConfiguration { id: string | null; categoryId: string | null; categoryName: string | null; limit: Money; officialUsed: Money; officialCount: number }
export interface BudgetDay { timeSec: number; spend: Money; totalSpend: Money }
export interface BudgetView { query: BudgetQuery; configurations: BudgetConfiguration[]; dayStats: BudgetDay[] | null; currency: string; editVersion: string; progress: BudgetProgress; dailyAvailable: Money | null; freshness: Freshness; incompleteReasons: string[]; problem?: Problem }
export interface BudgetLedgerSource { bills: BillDetail[]; range: TimeRange; freshness: Freshness; incompleteReasons: string[]; categories: { id: string; parentId: string | null }[] }
export const budgetDraftSchema = z.strictObject({ kind: z.literal('budget'), requestId: z.string().min(1).max(200), input: budgetQuerySchema.extend({ expectedVersion: z.string().length(64), changes: z.array(z.strictObject({ categoryId: categoryIdSchema.nullable(), limit: z.string().max(80) })).min(1).max(500) }) });
export type BudgetDraft = z.infer<typeof budgetDraftSchema>;
export interface BudgetDraftView { draft: BudgetDraft; operationId: string | null }
export interface BudgetDefinition { id: Id; categoryId: Id | null; limit: Money }
export interface BudgetCalculationInput { bills: BillDetail[]; budgets: BudgetDefinition[]; categories: { id: Id; parentId: Id | null }[]; currency: Id; range: TimeRange; nowSec: number }
export interface BudgetProgressRow extends BudgetDefinition { used: Money; count: number; remaining: Money; ratio: Money | null }
export interface BudgetProgress { used: Money; totalNotBudget: Money; rows: BudgetProgressRow[]; remainingDays: number; incompleteReasons: string[]; warnings: string[] }
