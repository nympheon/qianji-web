import { z } from 'zod';
import { historicalCurrencySchema } from './transfer-contract';
const id = z.string().regex(/^[1-9]\d{0,24}$/), money = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d{1,10})?$/);
export const refundFieldsSchema = z.strictObject({
  money: money.optional(), timeSec: z.int().min(0).max(253402300799), assetId: id.nullable(), remark: z.string().max(500).optional(),
  currency: historicalCurrencySchema.optional(), tagIds: z.array(z.string().min(1).max(200)).max(100).optional(), images: z.array(z.string().min(1).max(1024)).max(100).optional(),
});
export const refundInputSchema = refundFieldsSchema.extend({ billId: id, expectedVersion: z.string().length(64), refundBillId: id.optional(), refundExpectedVersion: z.string().length(64).optional() })
  .refine((input) => !!input.refundBillId === !!input.refundExpectedVersion, '编辑退款需要退款记录版本');
export type RefundInput = z.infer<typeof refundInputSchema>;
export const refundDraftSchema = z.strictObject({ kind: z.literal('refund'), requestId: z.string().min(1).max(200), billId: id, expectedVersion: z.string().length(64),
  refundBillId: id.optional(), refundExpectedVersion: z.string().length(64).optional(), fields: refundFieldsSchema.partial().extend({ money: z.string().max(80).optional(),
    currency: historicalCurrencySchema.extend({ srcValue: z.string().max(80), targetValue: z.string().max(80), baseValue: z.string().max(80) }).optional() }) });
export type RefundDraft = z.infer<typeof refundDraftSchema>;
