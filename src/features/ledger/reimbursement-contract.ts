import { z } from 'zod';
import { historicalCurrencySchema } from './transfer-contract';
import type { BillDetail } from './contract';
import type { Freshness } from '../../shared/model';
const id = z.string().regex(/^[1-9]\d{0,24}$/);
export const reimbursementSourcesSchema = z.array(z.strictObject({ id, expectedVersion: z.string().length(64) })).min(1).max(200);
export const cancelReimbursementInputSchema = z.strictObject({ bills: reimbursementSourcesSchema });
export const reimburseInputSchema = cancelReimbursementInputSchema.extend({
  assetId: id.nullable(), money: z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d{1,10})?$/),
  timeSec: z.int().min(0).max(253402300799), currency: historicalCurrencySchema.optional(),
  remark: z.string().max(500).optional(), tagIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  images: z.array(z.string().min(1).max(1024)).max(100).optional(),
});
export type ReimburseInput = z.infer<typeof reimburseInputSchema>;
export type CancelReimbursementInput = z.infer<typeof cancelReimbursementInputSchema>;
export const reimbursableInputSchema = cancelReimbursementInputSchema.extend({ reimbursable: z.boolean() });
export type ReimbursableInput = z.infer<typeof reimbursableInputSchema>;
export const reimbursementDraftSchema = z.strictObject({ kind: z.literal('reimbursement'), requestId: z.string().min(1).max(200),
  mode: z.enum(['reimburse', 'cancel', 'mark', 'unmark', 'delete']), fields: reimburseInputSchema.partial().extend({ bills: reimbursementSourcesSchema.min(0), money: z.string().max(80).optional(),
    currency: historicalCurrencySchema.extend({ srcValue: z.string().max(80), targetValue: z.string().max(80), baseValue: z.string().max(80) }).optional() }) });
export type ReimbursementDraft = z.infer<typeof reimbursementDraftSchema>;
export interface ReimbursementMembers { packId: string; items: BillDetail[]; complete: boolean; freshness: Freshness }
