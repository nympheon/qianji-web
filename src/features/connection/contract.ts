import { z } from 'zod';
import type { Id } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import type { RouteId } from '../../protocol/profile';

export const passwordLoginSchema = z.strictObject({
  account: z.string().trim().min(1).max(254).refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^\+?\d{5,20}$/.test(value), '请输入手机号或邮箱'),
  password: z.string().min(1).max(1024),
});
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;
export interface ConnectionView {
  state: 'disconnected' | 'connected' | 'needs_login'; uid: Id | null; connectionEpoch: string | null;
  route: RouteId; user: { name: string | null; vipType: string | null; vipEndSec: string | null } | null;
  lastCheckedAt: string | null; problem: Problem | null; refreshAvailable: boolean;
  protocolVersion: '4.5.4';
}
export interface RouteCheckView { route: RouteId; status: 'ok' | 'error' | 'unavailable'; latencyMs: number | null; error: Problem | null }
