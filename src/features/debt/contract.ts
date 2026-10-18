import { z } from 'zod';
import type { Freshness } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import type { AssetView } from '../assets/contract';
import type { DebtState } from './accounting';
import type { ExpectedAssetEffect } from '../../operations/contract';
import { bookIdSchema } from '../books/contract';
const id = z.string().regex(/^[1-9]\d{0,24}$/), money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/), version = z.string().length(64);
const date = z.iso.date();
const images = z.array(z.string().min(1).max(2048)).max(200).optional();
export const createDebtSchema = z.strictObject({ direction: z.enum(['borrow', 'lend']), name: z.string().trim().min(1).max(100), principal: money, bookId: bookIdSchema, aboutAssetId: id.nullable().optional(), startDate: date, endDate: date.nullable().optional(), inCount: z.boolean(), remark: z.string().max(500).optional(), images });
const fields = { principal: money, bookId: bookIdSchema, aboutAssetId: id.nullable(), timeSec: z.int().min(0).max(253402300799), remark: z.string().max(500).optional(), images };
export const appendPrincipalSchema = z.strictObject({ id, expectedVersion: version, ...fields });
export const editPrincipalSchema = z.strictObject({ id, expectedVersion: version, changes: z.strictObject({ ...fields, debtAssetId: id.optional() }).partial().refine((value) => Object.keys(value).length > 0) });
export const debtPaymentSchema = appendPrincipalSchema.extend({ interest: money.default('0') });
export const debtWriteSchemas = { 'debt.create': createDebtSchema, 'debt.appendPrincipal': appendPrincipalSchema, 'debt.editPrincipal': editPrincipalSchema, 'debt.pay': debtPaymentSchema };
export type CreateDebtInput = z.infer<typeof createDebtSchema>;
export type AppendPrincipalInput = z.infer<typeof appendPrincipalSchema>;
export type EditPrincipalInput = z.infer<typeof editPrincipalSchema>;
export type DebtPaymentInput = z.infer<typeof debtPaymentSchema>;
export const debtListSchema = z.strictObject({ direction: z.enum(['borrow', 'lend']), finished: z.boolean().default(false) });
export type DebtListInput = z.input<typeof debtListSchema>;
export interface DebtView { asset: AssetView; state: DebtState | null; aboutAssetId: string | null; startDate: string | null; endDate: string | null; loanInfoMissing: boolean }
export interface DebtListView { items: DebtView[]; freshness: Freshness; problem?: Problem }
export interface DebtPreview { debtId: string; principal: string; interest: string; overflow: boolean; expectedState: DebtState; effects: ExpectedAssetEffect[] }
export const debtPreviewSchema = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('debt.appendPrincipal'), input: appendPrincipalSchema }), z.strictObject({ action: z.literal('debt.editPrincipal'), input: editPrincipalSchema }), z.strictObject({ action: z.literal('debt.pay'), input: debtPaymentSchema })]);
const draft = { kind: z.literal('debt'), requestId: z.string().min(1).max(200) }, draftMoney = z.string().max(80);
export const debtDraftSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...draft, action: z.literal('debt.create'), input: createDebtSchema.extend({ name: z.string().max(100), principal: draftMoney }) }),
  z.strictObject({ ...draft, action: z.literal('debt.appendPrincipal'), input: appendPrincipalSchema.extend({ principal: draftMoney }) }),
  z.strictObject({ ...draft, action: z.literal('debt.editPrincipal'), input: editPrincipalSchema.extend({ changes: editPrincipalSchema.shape.changes.safeExtend({ principal: draftMoney.optional() }) }) }),
  z.strictObject({ ...draft, action: z.literal('debt.pay'), input: debtPaymentSchema.extend({ principal: draftMoney, interest: draftMoney }) }),
]);
export type DebtDraft = z.infer<typeof debtDraftSchema>;
export interface DebtDraftView { draft: DebtDraft; operationId: string | null }
