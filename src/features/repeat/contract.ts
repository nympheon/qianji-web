import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import { bookIdSchema } from '../books/contract';
import { historicalCurrencySchema } from '../ledger/transfer-contract';
import { planIdSchema, planBindingSchema } from '../plans/contract';
const money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/);
export const repeatRuleSchema = z.strictObject({ type: z.enum(['day', 'week', 'month', 'year', 'workday', 'bystep']), values: z.array(z.string().min(1).max(20)).max(366).default([]) }).superRefine((rule, ctx) => {
  const valid = rule.type === 'day' || rule.type === 'workday' ? rule.values.length === 0 : rule.type === 'bystep' ? rule.values.length === 1 && /^[1-9]\d{0,4}$/.test(rule.values[0]!) && Number(rule.values[0]) <= 36500 : rule.values.length > 0 && new Set(rule.values).size === rule.values.length && rule.values.every((value) => {
    if (rule.type === 'year') { const match = /^(\d{1,2})-(\d{1,2})$/.exec(value); if (!match) return false; const month = Number(match[1]), day = Number(match[2]); return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(2000, month, 0)).getUTCDate(); }
    return /^\d+$/.test(value) && (rule.type === 'week' ? Number(value) >= 1 && Number(value) <= 7 : Number(value) >= 1 && Number(value) <= 32 || ['291', '301'].includes(value));
  });
  if (!valid) ctx.addIssue({ code: 'custom', message: '周期规则的日期或间隔无效' });
});
export const repeatEndSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('date'), date: z.iso.date() }), z.strictObject({ kind: z.literal('count'), count: z.int().min(1).max(100000) })]).nullable();
const repeatFieldsBase = z.strictObject({ type: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(5)]), bookId: bookIdSchema, categoryId: planIdSchema.nullable(), fromAssetId: planIdSchema.nullable(), targetAssetId: planIdSchema.nullable(), enteredMoney: money, fee: money, startDate: z.iso.date(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), repeat: repeatRuleSchema, end: repeatEndSchema, remark: z.string().max(500), tagIds: z.array(z.string().min(1).max(200)).max(100), images: z.array(z.string().min(1).max(2048)).max(200), countInStatistics: z.boolean(), countInBudget: z.boolean(), currency: historicalCurrencySchema.nullable() });
export const repeatFieldsSchema = repeatFieldsBase.extend({ categoryId: repeatFieldsBase.shape.categoryId.default(null), fromAssetId: repeatFieldsBase.shape.fromAssetId.default(null), targetAssetId: repeatFieldsBase.shape.targetAssetId.default(null), fee: repeatFieldsBase.shape.fee.default('0'), time: repeatFieldsBase.shape.time.default('00:00'), end: repeatFieldsBase.shape.end.default(null), remark: repeatFieldsBase.shape.remark.default(''), tagIds: repeatFieldsBase.shape.tagIds.default([]), images: repeatFieldsBase.shape.images.default([]), countInStatistics: repeatFieldsBase.shape.countInStatistics.default(true), countInBudget: repeatFieldsBase.shape.countInBudget.default(true), currency: repeatFieldsBase.shape.currency.default(null) });
export type RepeatFields = z.infer<typeof repeatFieldsSchema>;
export const repeatSubmitSchema = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('create'), fields: repeatFieldsSchema }), z.strictObject({ mode: z.literal('edit'), id: planIdSchema, expectedVersion: z.string().length(64), changes: repeatFieldsBase.partial().refine((value) => Object.keys(value).length > 0) })]);
export const repeatPauseSchema = z.strictObject({ id: planIdSchema, paused: z.boolean() });
export const repeatDeleteSchema = z.strictObject({ id: planIdSchema, expectedVersion: z.string().length(64) });
export const repeatWriteSchemas = { 'repeat.submit': repeatSubmitSchema, 'repeat.setPaused': repeatPauseSchema, 'repeat.setBillBinding': planBindingSchema, 'repeat.delete': repeatDeleteSchema };
export type RepeatInput = z.infer<typeof repeatSubmitSchema>;
export const repeatQuerySchema = z.strictObject({ sort: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0), ascending: z.boolean().default(false), statuses: z.array(z.int().min(-3).max(1)).max(5).optional(), types: z.array(z.int()).max(5).optional() });
export type RepeatQuery = z.input<typeof repeatQuerySchema>;
export const repeatPreviewSchema = z.strictObject({ fields: repeatFieldsSchema, limit: z.int().min(1).max(120).default(12), zone: z.string().min(1).max(100).default('Asia/Shanghai') });
export type RepeatPreviewInput = z.input<typeof repeatPreviewSchema>;
export interface PreviewBill { date: string; timeSec: number; type: number; money: string; fee: string; remark: string }
export type HolidayYears = Record<string, Record<string, { holiday: boolean }>>;
export interface RepeatView { id: string; packId: string | null; type: number; count: number; status: number; createdAtSec: number; fields: RepeatFields | null; editVersion: string; unsupportedReason: string | null }
export interface RepeatListView { items: RepeatView[]; freshness: Freshness; problem?: Problem }
const draftFields = repeatFieldsBase.partial().extend({ enteredMoney: z.string().max(80).optional(), fee: z.string().max(80).optional(), startDate: z.string().max(10).optional(), time: z.string().max(5).optional(), repeat: z.strictObject({ type: repeatRuleSchema.shape.type, values: z.array(z.string().max(20)).max(366) }).optional(), end: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('date'), date: z.string().max(10) }), z.strictObject({ kind: z.literal('count'), count: z.int().min(0).max(100000) })]).nullable().optional(), currency: historicalCurrencySchema.extend({ srcValue: z.string().max(80), targetValue: z.string().max(80), baseValue: z.string().max(80) }).nullable().optional() });
export const repeatDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('repeat.submit'), requestId: z.string().min(1).max(200), input: z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('create'), fields: draftFields }), z.strictObject({ mode: z.literal('edit'), id: planIdSchema, expectedVersion: z.string().length(64), changes: draftFields })]) }),
  z.strictObject({ action: z.literal('repeat.setPaused'), requestId: z.string().min(1).max(200), input: repeatPauseSchema }),
  z.strictObject({ action: z.literal('repeat.setBillBinding'), requestId: z.string().min(1).max(200), input: planBindingSchema.extend({ billId: z.string().max(25) }) }),
  z.strictObject({ action: z.literal('repeat.delete'), requestId: z.string().min(1).max(200), input: repeatDeleteSchema }),
]);
export type RepeatDraft = z.infer<typeof repeatDraftSchema>;
export interface RepeatDraftView { draft: RepeatDraft; operationId: string | null }
