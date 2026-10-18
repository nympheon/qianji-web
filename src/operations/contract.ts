import type { ActorScope, Clock, Id } from '../shared/model';
import type { Problem } from '../shared/reply';
import type { WireJson } from '../shared/wire-json';
import type { QianjiClient, ProtocolReply } from '../protocol/client';
import type { Repository } from '../storage/database';
import type { SyncDomain } from '../storage/mirror';

export type OperationState = 'queued' | 'sending' | 'verifying' | 'succeeded' | 'failed' | 'uncertain' | 'partial';
export type ItemState = 'queued' | 'sending' | 'succeeded' | 'failed' | 'uncertain';
export interface MutationCommand { action: string; input: WireJson; scope: ActorScope; requestId: string }
export interface ExpectedAssetEffect { assetId: Id; currency: Id; delta: string; balanceBefore: string; expectedBalance: string; expectedLastPayTimeSec?: string; confirmation: 'expected' }
export interface PreparedItem { id: Id; affectedIds: readonly Id[]; assetEffects?: ExpectedAssetEffect[] }
export interface PreparedMutation { payload: WireJson; items: readonly PreparedItem[]; affectedIds: readonly Id[]; affectedDomains?: readonly SyncDomain[];
  received?:{applied:boolean;reply:{ec:string;data:WireJson;httpStatus:string;hasMore?:boolean}};
}
export interface OperationItem extends PreparedItem { state: ItemState; error: Problem | null }
export interface OperationView {
  id: Id; action: string; state: OperationState; items: OperationItem[];
  affectedIds: Id[]; idMap: Record<Id, Id>; error: Problem | null;
}
export function operationIsFinal(operation: OperationView): boolean {
  return operation.state === 'succeeded' || operation.state === 'failed' || (operation.state === 'partial' && operation.items.length > 0 && operation.items.every((item) => item.state === 'succeeded' || item.state === 'failed'));
}
export interface StoredOperation extends OperationView {
  scope: ActorScope; requestId: string; input: WireJson; digest: string;
  prepared: PreparedMutation | null; sendCount: number;
}
export interface ItemUpdate { id: Id; state: 'succeeded' | 'failed' | 'uncertain'; error?: Problem | null; affectedIds?: readonly Id[]; assetEffects?: ExpectedAssetEffect[] }
export interface OperationUpdate { items: readonly ItemUpdate[]; idMap?: Record<Id, Id>; error?: Problem | null; affectedIds?: readonly Id[] }
export interface ReconciliationResult extends OperationUpdate { receipt?: ProtocolReply }
export interface OperationContext {
  repository: Repository; client: QianjiClient; clock: Clock;
  /** A private runner may impose a narrower resource policy; never derived from public input. */
  authorizeMutation?: (command:MutationCommand) => void;
  authorizePrepared?: (command:MutationCommand, prepared:PreparedMutation) => void;
  /** Available only during the original send; never during read-only reconciliation. */
  currentOperation?: () => StoredOperation;
  checkpoint?: (prepared: PreparedMutation, update: OperationUpdate | (() => OperationUpdate)) => void;
}
export interface MutationHandler {
  prepare(command: MutationCommand, ctx: OperationContext): Promise<PreparedMutation>;
  send(prepared: PreparedMutation, ctx: OperationContext): Promise<ProtocolReply>;
  applyReceipt(prepared: PreparedMutation, reply: ProtocolReply, ctx: OperationContext): OperationUpdate;
  reconcile(operation: StoredOperation, ctx: OperationContext): Promise<ReconciliationResult>;
}
