import { z } from 'zod';
import type { ActorScope, Id } from '../../shared/model';
import type { Problem } from '../../shared/reply';
import type { WireJson } from '../../shared/wire-json';
import type { Freshness } from '../../shared/model';

export const syncInputSchema = z.strictObject({ domain: z.enum(['ledger', 'tags']), mode: z.enum(['incremental', 'rebuild']) });
export type SyncInput = z.infer<typeof syncInputSchema>;
export interface JobView {
  id: Id; domain: SyncInput['domain']; mode: SyncInput['mode'];
  state: 'running' | 'succeeded' | 'failed' | 'truncated'; phase: 'waiting' | 'pulling' | 'complete' | 'stopped';
  pages: number; receivedRecords: number; complete: boolean; error: Problem | null;
  coverage: 'ledger' | 'tag-rows';
  domains?: SyncInput['domain'][];
  children?: JobView[];
}
export interface SyncCheckpoint {
  scope: ActorScope; datasetId: Id; startCursor: WireJson; collectedTimes: WireJson;
  bookId: Id; pageOffset: Id; pageSign: string; tagPage: number; full: boolean;
  ownerJobId?: Id;
  prerequisiteTagJobId?:Id;
}
export type FreshnessMode = 'normal' | 'manual-incremental';
export interface FreshnessResult { freshness: Freshness; job: JobView | null; jobs: JobView[] }
