import type { ActorScope, Clock, Id } from '../shared/model';
import type { Problem } from '../shared/reply';
import type { WireJson } from '../shared/wire-json';
import type { QianjiClient, ProtocolReply } from '../protocol/client';
import type { Repository } from '../storage/database';

export type OperationState = 'queued' | 'sending' | 'verifying' | 'succeeded' | 'failed' | 'uncertain' | 'partial';
export type ItemState = 'queued' | 'sending' | 'succeeded' | 'failed' | 'uncertain';
export interface MutationCommand { action: string; input: WireJson; scope: ActorScope; requestId: string }
export interface PreparedItem { id: Id; affectedIds: readonly Id[] }
export interface PreparedMutation { payload: WireJson; items: readonly PreparedItem[]; affectedIds: readonly Id[] }
export interface OperationItem extends PreparedItem { state: ItemState; error: Problem | null }
export interface OperationView {
  id: Id; action: string; state: OperationState; items: OperationItem[];
  affectedIds: Id[]; idMap: Record<Id, Id>; error: Problem | null;
}
export interface StoredOperation extends OperationView {
  scope: ActorScope; requestId: string; input: WireJson; digest: string;
  prepared: PreparedMutation | null; sendCount: number;
}
export interface ItemUpdate { id: Id; state: 'succeeded' | 'failed' | 'uncertain'; error?: Problem | null }
export interface OperationUpdate { items: readonly ItemUpdate[]; idMap?: Record<Id, Id>; error?: Problem | null }
export interface ReconciliationResult extends OperationUpdate { receipt?: ProtocolReply }
export interface OperationContext { repository: Repository; client: QianjiClient; clock: Clock }
export interface MutationHandler {
  prepare(command: MutationCommand, ctx: OperationContext): Promise<PreparedMutation>;
  send(prepared: PreparedMutation, ctx: OperationContext): Promise<ProtocolReply>;
  applyReceipt(prepared: PreparedMutation, reply: ProtocolReply, ctx: OperationContext): OperationUpdate;
  reconcile(operation: StoredOperation, ctx: OperationContext): Promise<ReconciliationResult>;
}
