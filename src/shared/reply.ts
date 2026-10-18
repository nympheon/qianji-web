import type { Freshness, Id } from './model';

export interface Problem { code: string; message: string }

export interface AppReply<T> {
  status: 'ready' | 'running' | 'uncertain' | 'partial' | 'unavailable' | 'error';
  data: T | null;
  freshness: Freshness | null;
  jobId?: Id;
  operationId?: Id;
  error?: Problem;
}
