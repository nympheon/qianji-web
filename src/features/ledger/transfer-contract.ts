import { z } from 'zod';
import type { Freshness, Id, Money } from '../../shared/model';
import type { HistoricalCurrency } from './contract';
import type { ExpectedAssetEffect } from '../../operations/contract';
export type { ExpectedAssetEffect } from '../../operations/contract';
const id = z.string().regex(/^[1-9]\d{0,24}$/), money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/);
export const historicalCurrencySchema = z.strictObject({
  srcSymbol: z.string().min(1).max(20), srcValue: money, targetSymbol: z.string().min(1).max(20), targetValue: money,
  baseSymbol: z.string().min(1).max(20), baseValue: money,
});
export const transferFieldsSchema = z.strictObject({
  bookId: id, fromAssetId: id, targetAssetId: id, enteredMoney: money, fee: money, timeSec: z.int().min(0).max(253402300799),
  remark: z.string().max(500).optional(), currency: historicalCurrencySchema.nullable().optional(), tagIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  countInStatistics: z.boolean().optional(), countInBudget: z.boolean().optional(),
});
const create = transferFieldsSchema.extend({ mode: z.literal('create'), fee: money.default('0') });
const edit = z.strictObject({ mode: z.literal('edit'), id, expectedVersion: z.string().length(64), changes: transferFieldsSchema.partial().refine((value) => Object.keys(value).length > 0) });
const remove = z.strictObject({ mode: z.literal('delete'), id, expectedVersion: z.string().length(64) });
export const transferInputSchema = z.discriminatedUnion('mode', [create, edit, remove]);
const requestId = z.string().min(1).max(200);
export const transferActionSchema = z.discriminatedUnion('mode', [create.extend({ requestId }), edit.extend({ requestId }), remove.extend({ requestId })]);
export const transferDraftSchema = z.strictObject({ kind: z.enum(['transfer', 'repay-card']), mode: z.enum(['create', 'edit', 'delete']), requestId,
  fields: transferFieldsSchema.partial().extend({ enteredMoney: z.string().max(80).optional(), fee: z.string().max(80).optional(),
    currency: historicalCurrencySchema.extend({ srcValue: z.string().max(80), targetValue: z.string().max(80), baseValue: z.string().max(80) }).nullable().optional() }), billId: id.optional(), expectedVersion: z.string().length(64).optional() });
export type TransferDraft = z.infer<typeof transferDraftSchema>;
export type TransferInput = z.infer<typeof transferInputSchema>;
export interface TransferAsset { id: Id; name: string; type: number; currency: Id; money: Money; lastPayTimeSec: string }
export interface TransferAmounts { principal: Money; fee: Money; fromAmount: Money; targetAmount: Money; currency: HistoricalCurrency | null }
export interface TransferMovement { fromAssetId: Id; targetAssetId: Id; principal: Money; fee: Money; currency: HistoricalCurrency | null; type: 2 | 3; timeSec: number }
export interface TransferPreview extends TransferAmounts { from: TransferAsset; target: TransferAsset; effects: ExpectedAssetEffect[]; complete: boolean; stale: boolean; freshness: Freshness }
export interface TransferOptions { assets: TransferAsset[]; books: { id: Id; name: string }[]; baseCurrency: Id; complete: boolean; freshness: Freshness }
