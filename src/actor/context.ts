import type { Clock } from '../shared/model';
import { Repository } from '../storage/database';
import { QianjiClient } from '../protocol/client';
import { Coordinator } from './coordinator';
import { CredentialVault } from '../features/connection/vault';
import { ConnectionService } from '../features/connection/service';
import type { RouteId } from '../protocol/profile';
import { SyncService } from '../features/sync/service';
import { RebuildService } from '../features/sync/rebuild';
import { FreshnessService } from '../features/sync/freshness';
import { ResourceCache } from '../storage/cache';
import { LedgerService } from '../features/ledger/service';
import { createLedgerMutationHandler } from '../features/ledger/write';
import { LedgerWriteService } from '../features/ledger/write-service';
import { createTransferMutationHandler } from '../features/ledger/transfer';
import { createRefundMutationHandler } from '../features/ledger/refund';
import { createReimbursementMutationHandler, createReimbursableMutationHandler } from '../features/ledger/reimbursement';
import { createLedgerDeletionHandler } from '../features/ledger/deletion';
import { AssetService } from '../features/assets/service';
import { createAssetMutationHandler } from '../features/assets/use-cases';
import { createAssetGroupMutationHandler } from '../features/assets/groups';
import { createDebtMutationHandler, createDebtBillMutationHandler } from '../features/debt/use-cases';
import { DebtService } from '../features/debt/service';
import { BookService } from '../features/books/service';
import { createBookMutationHandler } from '../features/books/use-cases';
import { AccountingConfiguration, createAccountingConfigurationHandler } from '../features/books/accounting';

export function createActorContext(storage: DurableObjectStorage, secrets: { QIANJI_CREDENTIAL_KEY?: string } = {}, execution?: { waitUntil(task: Promise<unknown>): void }) {
  const repository = new Repository(storage);
  const clock: Clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
  const accounting = new AccountingConfiguration({ repository, clock });
  const baseCurrency = () => { const current = connection.scope(); return current ? accounting.read(current).baseCurrency : 'CNY'; };
  const client = new QianjiClient({
    clock,
    deviceId: () => repository.sql.exec<{ device_id: string }>('SELECT device_id FROM connection WHERE singleton=1').one().device_id,
    route: () => repository.sql.exec<{ route: string }>('SELECT route FROM connection WHERE singleton=1').one().route as RouteId,
    session: (scope) => connection.session(scope),
    onSessionExpired: (scope, generation) => connection.expire(scope, generation),
  });
  const executionOptions = execution ? { background: (task: Promise<unknown>) => execution.waitUntil(task) } : undefined;
  const background = executionOptions ?? {};
  const reconcileSource = async () => {
    const current = connection.scope(); if (!current) return false;
    const result = await freshness.ensureFresh(current, ['ledger'], 'manual-incremental');
    return result.job?.state === 'succeeded';
  };
  const billHandler = createLedgerMutationHandler({ reconcileSource }), transferHandler = createTransferMutationHandler({ reconcileSource, baseCurrency });
  const refundHandler = createRefundMutationHandler({ reconcileSource, baseCurrency }), deletionHandler = createLedgerDeletionHandler({ reconcileSource, baseCurrency });
  const reimbursementHandler = createReimbursementMutationHandler({ baseCurrency, reconcileSource: async (ctx, ids) => { if (!await reconcileSource()) return false; for (const id of ids) await assets.refreshInfo(id, ctx.client); return true; } });
  const assetHandler = createAssetMutationHandler({ reconcileLedger: reconcileSource }), groupHandler = createAssetGroupMutationHandler();
  const debtHandler = createDebtBillMutationHandler({ reconcileSource, baseCurrency }), bookHandler = createBookMutationHandler();
  const coordinator = new Coordinator({ repository, client, clock }, new Map([['books.setBaseCurrency', createAccountingConfigurationHandler({ configuration: accounting, reconcileSource: async () => { const view = await connection.check(); return view.state === 'connected' && view.problem === null; } })], ...['books.submit', 'books.configure', 'books.delete', 'books.quit', 'books.setVisible', 'books.reorder'].map((action) => [action, bookHandler] as const), ['debt.create', createDebtMutationHandler({ baseCurrency })], ...['debt.appendPrincipal', 'debt.editPrincipal', 'debt.pay'].map((action) => [action, debtHandler] as const), ...['assets.submit', 'assets.adjustBalance', 'assets.setFinished', 'assets.setVisible', 'assets.reorder', 'assets.delete'].map((action) => [action, assetHandler] as const), ...['assets.groups.submit', 'assets.groups.delete', 'assets.groups.reorder', 'assets.groups.add', 'assets.groups.remove'].map((action) => [action, groupHandler] as const), ...['ledger.create', 'ledger.edit'].map((action) => [action, billHandler] as const), ...['ledger.transfer', 'ledger.repayCard'].map((action) => [action, transferHandler] as const), ...['ledger.reimburse', 'ledger.cancelReimbursement'].map((action) => [action, reimbursementHandler] as const), ['ledger.setReimbursable', createReimbursableMutationHandler({ reconcileSource })], ['ledger.refund', refundHandler], ['ledger.delete', deletionHandler]]), executionOptions);
  const instanceId = repository.sql.exec<{ value: string }>("SELECT value FROM instance_meta WHERE key='instance_id'").one().value;
  const vault = new CredentialVault(secrets.QIANJI_CREDENTIAL_KEY, instanceId);
  const connection = new ConnectionService({ repository, client, coordinator, clock, vault, onUserConfig: (scope, value) => accounting.applyOfficial(scope, value) });
  const cache = new ResourceCache(repository, clock);
  const sync = new SyncService({ repository, client, coordinator, clock, connection, rebuild: (scope, domains) => rebuild.rebuild(scope, domains), ...background });
  const rebuild = new RebuildService({ repository, cache, client, coordinator, clock, connection, sync, ...background });
  const freshness = new FreshnessService({ repository, clock, sync });
  const assets = new AssetService({ repository, cache, client, clock, connection, coordinator, baseCurrency });
  const ledgerWrites = new LedgerWriteService({ repository, coordinator, connection, clock, assetSource: assets, baseCurrency });
  const ledger = new LedgerService({ repository, connection, freshness, clock, writes: ledgerWrites, baseCurrency });
  const debt = new DebtService({ repository, cache, client, clock, connection, coordinator, ledgerWrites, baseCurrency });
  const books = new BookService({ repository, cache, client, clock, connection, coordinator, accounting, vipExpired: () => connection.isVipExpired() });
  return { repository, clock, client, coordinator, connection, sync, cache, rebuild, freshness, ledger, ledgerWrites, assets, debt, books, accounting };
}
