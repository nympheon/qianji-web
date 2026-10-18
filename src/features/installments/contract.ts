import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import { bookIdSchema } from '../books/contract';
import { planIdSchema, planBindingSchema } from '../plans/contract';
import { historicalCurrencySchema } from '../ledger/transfer-contract';
const money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/);
export const remainderSchema = z.enum(['first', 'last', 'rndf', 'rnd', 'intf', 'intl']);
export type RemainderMode = z.infer<typeof remainderSchema>;
export const feePlacementSchema = z.enum(['ave', 'first', 'last']);
const amountsBase = z.strictObject({ totalMoney: money, totalFee: money, totalCount: z.int().min(1).max(10000), firstDate: z.iso.date(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), remainder: remainderSchema, feePlacement: feePlacementSchema, zone: z.string().min(1).max(100) });
export const installmentAmountsSchema = amountsBase.extend({ totalFee: money.default('0'), time: amountsBase.shape.time.default('00:00'), remainder: remainderSchema.default('first'), feePlacement: feePlacementSchema.default('ave'), zone: amountsBase.shape.zone.default('Asia/Shanghai') });
const fieldsBase = amountsBase.extend({ name: z.string().trim().min(1).max(100), bookId: bookIdSchema, assetId: planIdSchema, categoryId: planIdSchema, inCount: z.boolean(), feeInCount: z.boolean(), countInStatistics: z.boolean(), countInBudget: z.boolean(), remark: z.string().max(500), tagIds: z.array(z.string().min(1).max(200)).max(100), images: z.array(z.string().min(1).max(2048)).max(200) });
export const installmentCreateSchema = fieldsBase.extend({ ...installmentAmountsSchema.shape, inCount: z.boolean().default(true), feeInCount: z.boolean().default(false), countInStatistics: z.boolean().default(true), countInBudget: z.boolean().default(true), remark: z.string().max(500).default(''), tagIds: fieldsBase.shape.tagIds.default([]), images: fieldsBase.shape.images.default([]) });
export type CreateInstallmentInput = z.infer<typeof installmentCreateSchema>;
export const installmentConfigureSchema = z.strictObject({ id: planIdSchema, expectedVersion: z.string().length(64), inCount: z.boolean(), feeInCount: z.boolean() });
const currencyValues = historicalCurrencySchema.extend({ srcFee: money.default('0') });
export const installmentPrepaySchema = z.strictObject({ id: planIdSchema, expectedVersion: z.string().length(64), bookId: bookIdSchema, fromAssetId: planIdSchema, money, fee: money.default('0'), timeSec: z.int().min(0).max(253402300799), remark: z.string().max(500).default(''), images: fieldsBase.shape.images.default([]), spendCurrency: currencyValues.optional(), transferCurrency: currencyValues.optional() });
export type PrepayInput = z.infer<typeof installmentPrepaySchema>;
export const installmentDeleteSchema = z.strictObject({ id: planIdSchema, expectedVersion: z.string().length(64) });
export const installmentWriteSchemas = { 'installments.create': installmentCreateSchema, 'installments.configure': installmentConfigureSchema, 'installments.prepay': installmentPrepaySchema, 'installments.setBillBinding': planBindingSchema, 'installments.delete': installmentDeleteSchema };
export const installmentQuerySchema = z.strictObject({ sort: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0), ascending: z.boolean().default(false), assetId: planIdSchema.optional(), statuses: z.array(z.int().min(-3).max(1)).max(5).optional() });
export type InstallmentQuery = z.input<typeof installmentQuerySchema>;
export const installmentPreviewSchema = installmentAmountsSchema.extend({ limit: z.int().min(1).max(120).default(120), assetId: planIdSchema.optional() });
export type InstallmentPreviewInput = z.input<typeof installmentPreviewSchema>;
export interface InstallmentPreview { rows: { period: number; date: string; timeSec: number; principal: string; fee: string; money: string; coveredByInitialCount: boolean }[]; initialCount: number; complete: boolean; warnings: string[]; totals: { principal: string; fee: string; money: string }; currency: string | null }
export interface InstallmentView { id: string; packId: string | null; name: string; type: number; assetId: string | null; bookId: string | null; categoryId: string | null; totalMoney: string; totalFee: string; averageMoney: string; averageFee: string; totalCount: number; count: number; startTimeSec: number; firstDate: string; status: number; inCount: boolean; feeInCount: boolean; prepaidAtSec: number; remainder: string; feePlacement: string; images: string[]; tagIds: string[]; remark: string; editVersion: string; prepayVersion: string }
export interface InstallmentListView { items: InstallmentView[]; freshness: Freshness; problem?: Problem }
const draftAmounts = { name: z.string().max(100).optional(), totalMoney: z.string().max(80).optional(), totalFee: z.string().max(80).optional(), firstDate: z.string().max(10).optional(), time: z.string().max(5).optional() };
const requestId = z.string().min(1).max(200);
export const installmentDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('installments.create'), requestId, input: fieldsBase.partial().extend(draftAmounts) }),
  z.strictObject({ action: z.literal('installments.configure'), requestId, input: installmentConfigureSchema }),
  z.strictObject({ action: z.literal('installments.prepay'), requestId, input: installmentPrepaySchema.extend({ money: z.string().max(80), fee: z.string().max(80), fromAssetId: z.string().max(25), spendCurrency: currencyValues.extend({ srcValue: z.string().max(80), targetValue: z.string().max(80), baseValue: z.string().max(80) }).optional(), transferCurrency: currencyValues.extend({ srcValue: z.string().max(80), targetValue: z.string().max(80), baseValue: z.string().max(80) }).optional() }) }),
  z.strictObject({ action: z.literal('installments.setBillBinding'), requestId, input: planBindingSchema.extend({ billId: z.string().max(25) }) }),
  z.strictObject({ action: z.literal('installments.delete'), requestId, input: installmentDeleteSchema }),
]);
export type InstallmentDraft = z.infer<typeof installmentDraftSchema>;
export interface InstallmentDraftView { draft: InstallmentDraft; operationId: string | null }
