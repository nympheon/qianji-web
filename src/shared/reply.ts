import type { Freshness, Id } from './model';
import { z } from 'zod';

export interface Problem { code: string; message: string }

export interface AppReply<T> {
  status: 'ready' | 'running' | 'uncertain' | 'partial' | 'unavailable' | 'error';
  data: T | null;
  freshness: Freshness | null;
  jobId?: Id;
  operationId?: Id;
  error?: Problem;
}
export const appReplySchema = z.strictObject({
  status: z.enum(['ready', 'running', 'uncertain', 'partial', 'unavailable', 'error']), data: z.unknown(),
  freshness: z.strictObject({ revision: z.string(), complete: z.boolean(), stale: z.boolean(), syncedAt: z.string().nullable() }).nullable(),
  jobId: z.string().optional(), operationId: z.string().optional(), error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export function parseAppReply(value: unknown): AppReply<unknown> {
  const reply = appReplySchema.parse(value);
  return { status: reply.status, data: reply.data, freshness: reply.freshness, ...(reply.jobId !== undefined ? { jobId: reply.jobId } : {}), ...(reply.operationId !== undefined ? { operationId: reply.operationId } : {}), ...(reply.error ? { error: reply.error } : {}) };
}
