import { z } from 'zod';
export const planIdSchema = z.string().regex(/^[1-9]\d{0,24}$/);
export const planBindingSchema = z.strictObject({ planId: planIdSchema, packId: planIdSchema, billId: planIdSchema, bound: z.boolean() });
export type PlanBindingInput = z.infer<typeof planBindingSchema>;
