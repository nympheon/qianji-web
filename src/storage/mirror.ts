import type { Id, Money } from '../shared/model';
import type { WireJson } from '../shared/wire-json';
import type { ResourceRecord } from './resources';

export type SyncDomain = 'ledger' | 'tags' | 'assets' | 'debt' | 'books'
  | 'categories' | 'budget' | 'repeat' | 'installments' | 'savings' | 'attachments';
export interface BillRelation { kind: string; targetId: Id; raw: WireJson }
export interface BillRecord {
  id: Id; bookId: Id; type: number; timeSec: number; money: Money;
  raw: WireJson; relations: readonly BillRelation[];
}
export interface MirrorPage {
  upserts: readonly BillRecord[];
  deletes: readonly Id[];
  resources: readonly ResourceRecord[];
  pageState: WireJson;
  cursor?: WireJson;
  complete?: boolean;
  validatedAt?: string | null;
}
export interface DatasetView {
  id: Id; domain: SyncDomain; revision: string; complete: boolean; validatedAt: string | null;
}
