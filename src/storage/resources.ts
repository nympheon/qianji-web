import type { Id } from '../shared/model';
import type { WireJson } from '../shared/wire-json';
import type { SyncDomain } from './mirror';

export type ResourceKind = 'book' | 'bookType' | 'bookMember' | 'category' | 'tag' | 'tagGroup' | 'asset' | 'assetGroup' | 'assetType' | 'assetSnapshot'
  | 'debt' | 'budget' | 'repeat' | 'installment' | 'savings' | 'attachment';
export interface ResourceRecord { id: Id; kind: ResourceKind; raw: WireJson }
export interface ResourceQuery { domain: SyncDomain; ids?: readonly Id[]; limit?: number; cursor?: string }
export interface ResourcePage { items: ResourceRecord[]; nextCursor: string | null; revision: string }
