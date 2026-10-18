import {bookOptions} from './options';
import type { Coordinator } from '../../actor/coordinator';
import type { Repository } from '../../storage/database';
import type { ConnectionService } from '../connection/service';
import { DomainError } from '../../shared/errors';
import type { MutationCommand, OperationView } from '../../operations/contract';
import { operationIsFinal } from '../../operations/contract';
import { ledgerDraftSchema, type LedgerDraft, type BillDraftView, type CreateBillsInput, type DeleteBillsInput, type EditBillsInput } from './write-contract';
import { asBillObject } from '../../shared/bill-wire';
import { restoreBillInput } from './write';
import type { Clock, Freshness } from '../../shared/model';
import type { TransferInput, TransferOptions, TransferPreview } from './transfer-contract';
import { loadTransferAsset, previewTransfer } from './transfer';
import type { RefundInput } from './refund-contract';
import type { CancelReimbursementInput, ReimburseInput, ReimbursableInput } from './reimbursement-contract';
import type { AssetService } from '../assets/service';
import { ResourceCache } from '../../storage/cache';
import { assetListKey } from '../assets/service';

export class LedgerWriteService {
  constructor(private readonly dependencies: { repository: Repository; coordinator: Coordinator; connection: Pick<ConnectionService, 'scope'>; clock?: Clock; baseCurrency?: () => string; assetSource?: AssetService }) {}
  private scope() { const scope = this.dependencies.connection.scope(); if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
  private submit(action: string, input: MutationCommand['input'], meta: { requestId: string }): Promise<OperationView> {
    return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() });
  }
  create(input: CreateBillsInput, meta: { requestId: string }) { return this.submit('ledger.create', input, meta); }
  edit(input: EditBillsInput, meta: { requestId: string }) { return this.submit('ledger.edit', input, meta); }
  remove(input: DeleteBillsInput, meta: { requestId: string }) { return this.submit('ledger.delete', input, meta); }
  transfer(input: TransferInput, meta: { requestId: string }) { return this.submit('ledger.transfer', input, meta); }
  repayCard(input: TransferInput, meta: { requestId: string }) { return this.submit('ledger.repayCard', input, meta); }
  refund(input: RefundInput, meta: { requestId: string }) { return this.submit('ledger.refund', input, meta); }
  reimburse(input: ReimburseInput, meta: { requestId: string }) { return this.submit('ledger.reimburse', input, meta); }
  cancelReimbursement(input: CancelReimbursementInput, meta: { requestId: string }) { return this.submit('ledger.cancelReimbursement', input, meta); }
  setReimbursable(input: ReimbursableInput, meta: { requestId: string }) { return this.submit('ledger.setReimbursable', input, meta); }
  private transferFreshness(): Freshness {
    const scope = this.scope(), repository = this.dependencies.repository;
    const datasets = ['ledger', 'assets'].map((domain) => repository.dataset(scope, domain as 'ledger' | 'assets'));
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    const clock = this.dependencies.clock ?? { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() }, cache = new ResourceCache(repository, clock);
    const hasQuery = repository.sql.exec("SELECT 1 FROM source_queries WHERE uid=? AND domain='assets' AND query_key=?", scope.uid, assetListKey().queryKey).toArray().length > 0;
    const assetSource = hasQuery ? cache.read(scope, assetListKey()) : null;
    const invalid = repository.sql.exec("SELECT 1 FROM source_queries WHERE uid=? AND domain='assets' AND query_key=? AND invalidated=1 LIMIT 1", scope.uid, assetListKey().queryKey).toArray().length > 0;
    const complete = !!datasets[0]?.complete && (assetSource?.complete ?? !!datasets[1]?.complete) && !invalid && !repository.hasUncertainty(scope, 'assets') && !repository.hasUncertainty(scope, 'ledger');
    const times = [datasets[0]?.validatedAt ? Date.parse(datasets[0].validatedAt) : null, assetSource?.validatedAt ?? (datasets[1]?.validatedAt ? Date.parse(datasets[1].validatedAt) : null)];
    return { revision: datasets.map((dataset) => `${dataset?.id ?? 'unloaded'}:${dataset?.revision ?? '0'}`).join('|'), complete,
      stale: !connected || !complete || times.some((time) => time === null || (this.dependencies.clock?.nowMs() ?? Date.now()) - time >= 60_000),
      syncedAt: times.every((time) => time !== null) ? new Date(Math.min(...times as number[])).toISOString() : null };
  }
  async transferOptions(): Promise<TransferOptions> {
    const source = await this.dependencies.assetSource?.list({ status: 0, limit: 200 });
    const scope = this.scope(), repository = this.dependencies.repository, baseCurrency = this.dependencies.baseCurrency?.() ?? 'CNY';
    const assets = repository.readResources(scope, 'asset', { domain: 'assets', limit: 200 }), books = bookOptions(repository,this.dependencies.clock??{nowMs:()=>Date.now(),nowIso:()=>new Date().toISOString()},scope);
    const baseFreshness = this.transferFreshness(),freshness={...baseFreshness,complete:baseFreshness.complete&&books.complete,stale:baseFreshness.stale||books.stale};
    const ids = source?.freshness.syncedAt ? source.items.map((asset) => asset.id) : assets.items.map((asset) => asset.id);
    return { assets: ids.map((id) => loadTransferAsset({ repository }, scope, id, baseCurrency)),
      books: books.items.map((book) => ({ id: book.id, name: typeof asBillObject(book.raw).name === 'string' ? String(asBillObject(book.raw).name) : book.id })), baseCurrency, complete: freshness.complete && !(source?.nextCursor ?? assets.nextCursor) && books.complete, freshness };
  }
  previewTransfer(kind: 'transfer' | 'repay-card', input: TransferInput): TransferPreview {
    const clock = this.dependencies.clock ?? { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
    const result = previewTransfer({ action: kind === 'transfer' ? 'ledger.transfer' : 'ledger.repayCard', input, requestId: 'preview', scope: this.scope() }, { repository: this.dependencies.repository, clock }, this.dependencies.baseCurrency?.() ?? 'CNY');
    const freshness = this.transferFreshness(); return { ...result, complete: freshness.complete, stale: freshness.stale, freshness };
  }
  getDraft(key: string): BillDraftView | null {
    const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `bill:${key}`);
    if (raw === null) return null;
    // Draft fields contain only safe integers, text money and text IDs, never upstream raw data.
    const draft = ledgerDraftSchema.parse(restoreBillInput(raw));
    const operation = this.dependencies.coordinator.store.find(scope, draft.requestId);
    return { draft, operationId: operation?.id ?? null };
  }
  saveDraft(key: string, draft: LedgerDraft): BillDraftView {
    draft = ledgerDraftSchema.parse(draft);
    const scope = this.scope(), previous = this.getDraft(key);
    const operation = previous?.operationId ? this.dependencies.coordinator.getOperation(scope, previous.operationId) : null;
    if (operation && !operationIsFinal(operation)) throw new DomainError('DRAFT_OPERATION_PENDING', '草稿已有在途或待核查操作，请查看原操作');
    const existing = this.dependencies.coordinator.store.find(scope, draft.requestId);
    if (existing) throw new DomainError('DRAFT_ALREADY_SUBMITTED', '该草稿已提交，请查看原操作后再建立新草稿');
    this.dependencies.repository.saveDraft(scope, `bill:${key}`, asBillObject({ ...draft, fields: { ...draft.fields } }));
    return { draft, operationId: null };
  }
}
