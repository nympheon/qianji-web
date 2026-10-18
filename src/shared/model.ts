export type Id = string;
export type Money = string;
export interface ActorScope { uid: Id; connectionEpoch: string }
export interface CallMeta { requestId?: string }
export interface Clock { nowMs(): number; nowIso(): string }
export interface Freshness {
  revision: string;
  complete: boolean;
  stale: boolean;
  /** Last complete upstream validation for the declared scope. */
  syncedAt: string | null;
}

export type DateFilter =
  | { kind: 'day'; date: string }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'year'; year: number }
  | { kind: 'range'; from: string; to: string };

export interface BookPeriod { monthStartDay: number }
export interface TimeRange { startSec: number; endSec: number; zone: string }
export type { AppReply, Problem } from './reply';
