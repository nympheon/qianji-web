import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import { historicalCurrencySchema } from '../ledger/transfer-contract';
import { bookIdSchema } from '../books/contract';
const money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/), id = z.string().min(1).max(200), assetId = z.string().regex(/^[1-9]\d{0,24}$/);
export const savingsModes = ['fixedAmount', 'fixedAmount12', 'fixedAmount36', 'daily365', 'weekly52', 'reverseWeekly52', 'custom'] as const;
export const savingsModeSchema = z.enum(savingsModes);
const dates = { startDate: z.iso.date(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('00:00'), zone: z.string().min(1).max(100).default('Asia/Shanghai') };
const fixed = { ...dates, amount: money }, increasing = { ...dates, initialAmount: money, increment: money };
export const savingsRuleSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fixedAmount'), ...fixed, period: z.int().min(1).max(2147483647), frequency: z.enum(['day','week','month','quarter','year']) }),
  z.strictObject({ mode: z.literal('fixedAmount12'), ...fixed }), z.strictObject({ mode: z.literal('fixedAmount36'), ...fixed }),
  z.strictObject({ mode: z.literal('daily365'), ...increasing }), z.strictObject({ mode: z.literal('weekly52'), ...increasing }), z.strictObject({ mode: z.literal('reverseWeekly52'), ...increasing }),
  z.strictObject({ mode: z.literal('custom'), ...dates, total: money, endDate: z.iso.date().nullable().default(null) }),
]);
export type SavingsRule = z.infer<typeof savingsRuleSchema>;
const fields = z.strictObject({ name: z.string().trim().min(1).max(100), currency: z.string().min(1).max(20), rule: savingsRuleSchema, remark: z.string().max(500), icon: z.string().max(2048), color: z.string().regex(/^[0-9a-fA-F]{6}$/) });
const changes = fields.partial();
export const savingsSubmitSchema = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('create'), fields: fields.extend({ remark: fields.shape.remark.default(''), icon: fields.shape.icon.default(''), color: fields.shape.color.default('3792FA') }) }), z.strictObject({ mode: z.literal('edit'), planId: id, expectedVersion: z.string().length(64), changes })]);
export const savingsBillInfoSchema = z.strictObject({ bookId: bookIdSchema, outAssetId: assetId, inAssetId: assetId, currency: historicalCurrencySchema.extend({ srcFee: money.default('0') }).optional(), images: z.array(z.string().min(1).max(2048)).max(200).default([]), tagIds: z.array(id).max(100).default([]) });
export const savingsDepositSchema = z.strictObject({ planId: id, expectedCurrency: z.string().min(1).max(20), amount: money, remark: z.string().max(500).default(''), timeSec: z.int().min(0).max(253402300799), billInfo: savingsBillInfoSchema.optional() });
export const savingsCancelSchema = z.strictObject({ planId: id, transId: id, expectedVersion: z.string().length(64) });
export const savingsDeleteSchema = z.strictObject({ planId: id, deleteBills: z.boolean() });
export const savingsReorderSchema = z.strictObject({ planIds: z.array(id).min(1).max(1000) });
export const savingsWriteSchemas = { 'savings.submit': savingsSubmitSchema, 'savings.deposit': savingsDepositSchema, 'savings.cancelDeposit': savingsCancelSchema, 'savings.delete': savingsDeleteSchema, 'savings.reorder': savingsReorderSchema };
export const savingsQuerySchema = z.strictObject({ statuses: z.array(z.union([z.literal(1),z.literal(2)])).max(2).optional() });
export type SavingsQuery = z.input<typeof savingsQuerySchema>;
export const savingsProjectSchema = z.strictObject({ rule: savingsRuleSchema, limit: z.int().min(1).max(120).default(120) });
export interface SavingsProjection { rows: { period: number; date: string; timeSec: number; amount: string }[]; totalAmount: string; periods: number | null; complete: boolean; kind: 'schedule' | 'flexible-target' }
export interface SavingsTransactionView { transId: string; planId: string; amount: string; timeSec: number; remark: string; billId: string | null; version: string }
export interface SavingsView { planId: string; name: string; currency: string; mode: string; fields: z.infer<typeof fields> | null; status: number; savedAmount: string; transactions: SavingsTransactionView[]; editVersion: string; unsupportedReason: string | null }
export interface SavingsListView { items: SavingsView[]; freshness: Freshness; problem?: Problem }
const draftRule = z.strictObject({ mode: savingsModeSchema, startDate: z.string().max(10).optional(), time: z.string().max(5).optional(), zone: z.string().max(100).optional(), amount: z.string().max(80).optional(), initialAmount: z.string().max(80).optional(), increment: z.string().max(80).optional(), period: z.int().min(0).max(2147483647).optional(), frequency: z.enum(['day','week','month','quarter','year']).optional(), total: z.string().max(80).optional(), endDate: z.string().max(10).nullable().optional() });
const draftFields = fields.partial().extend({ name: z.string().max(100).optional(), rule: draftRule.optional() });
const requestId = id;
export const savingsDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('savings.submit'), requestId, input: z.discriminatedUnion('mode',[z.strictObject({ mode: z.literal('create'), fields: draftFields }),z.strictObject({ mode:z.literal('edit'),planId:id,expectedVersion:z.string().length(64),changes:draftFields })]) }),
  z.strictObject({ action:z.literal('savings.deposit'), requestId, input:savingsDepositSchema.extend({ amount:z.string().max(80),billInfo:savingsBillInfoSchema.extend({ outAssetId:z.string().max(25),inAssetId:z.string().max(25),currency:historicalCurrencySchema.extend({srcValue:z.string().max(80),targetValue:z.string().max(80),baseValue:z.string().max(80),srcFee:z.string().max(80).default('0')}).optional() }).optional() }) }),
  z.strictObject({ action:z.literal('savings.cancelDeposit'),requestId,input:savingsCancelSchema }), z.strictObject({ action:z.literal('savings.delete'),requestId,input:savingsDeleteSchema }),z.strictObject({ action:z.literal('savings.reorder'),requestId,input:savingsReorderSchema }),
]);
export type SavingsDraft = z.infer<typeof savingsDraftSchema>;
export interface SavingsDraftView { draft:SavingsDraft;operationId:string|null }
