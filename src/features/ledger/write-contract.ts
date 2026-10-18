import { z } from 'zod';
import { transferDraftSchema } from './transfer-contract';
import { refundDraftSchema } from './refund-contract';
import { reimbursementDraftSchema } from './reimbursement-contract';
import { bookIdSchema } from '../books/contract';

const id = z.string().regex(/^[1-9]\d{0,24}$/), money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/);
export const billChangesSchema = z.strictObject({
  bookId: bookIdSchema.optional(), type: z.union([z.literal(0), z.literal(1), z.literal(5)]).optional(), enteredMoney: money.optional(),
  fee: money.optional(), timeSec: z.int().min(0).max(253402300799).optional(), categoryId: id.optional(),
  assetId: id.nullable().optional(), remark: z.string().max(500).optional(), tagIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  countInStatistics: z.boolean().optional(), countInBudget: z.boolean().optional(),
});
export const newBillSchema = billChangesSchema.required({ bookId: true, type: true, enteredMoney: true, timeSec: true, categoryId: true });
export const createBillsSchema = z.strictObject({ bills: z.array(newBillSchema).min(1).max(1000) });
export const editBillsSchema = z.strictObject({ bills: z.array(z.strictObject({ id, expectedVersion: z.string().length(64), changes: billChangesSchema.refine((value) => Object.keys(value).length > 0) })).min(1).max(1000) });
export const deleteBillsSchema = z.strictObject({ bills: z.array(z.strictObject({ id, expectedVersion: z.string().length(64) })).min(1).max(1000) });
export type NewBill = z.infer<typeof newBillSchema>;
export type BillChanges = z.infer<typeof billChangesSchema>;
export type CreateBillsInput = z.infer<typeof createBillsSchema>;
export type EditBillsInput = z.infer<typeof editBillsSchema>;
export type DeleteBillsInput = z.infer<typeof deleteBillsSchema>;
export const billDraftSchema = z.strictObject({
  kind: z.enum(['create', 'edit']), requestId: z.string().min(1).max(200), fields: billChangesSchema.extend({ enteredMoney: z.string().max(80).optional(), fee: z.string().max(80).optional() }),
  billId: id.optional(), expectedVersion: z.string().length(64).optional(),
});
export type BillDraft = z.infer<typeof billDraftSchema>;
export const ledgerDraftSchema = z.union([billDraftSchema, transferDraftSchema, refundDraftSchema, reimbursementDraftSchema]);
export type LedgerDraft = z.infer<typeof ledgerDraftSchema>;
export interface BillDraftView { draft: LedgerDraft; operationId: string | null }
