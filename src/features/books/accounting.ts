import type { MutationHandler } from '../../operations/contract';
import type { Repository } from '../../storage/database';
import type { Clock, ActorScope } from '../../shared/model';
import { asBillObject, numericText } from '../../shared/bill-wire';
import type { WireJson } from '../../shared/wire-json';
import { stringifyWire } from '../../shared/wire-json';
import { baseCurrencyInputSchema, baseCurrencySchema, type AccountingConfigView } from './contract';
import { assetError } from '../assets/model';
import { billVersion, restoreBillInput } from '../ledger/write';
export class AccountingConfiguration {
  constructor(private readonly dependencies: { repository: Repository; clock: Clock }) {}
  read(scope: ActorScope): AccountingConfigView {
    const { repository, clock } = this.dependencies; repository.assertScope(scope);
    const row = repository.sql.exec<{ base_currency: string; revision: number; validated_ms: number }>('SELECT * FROM accounting_config WHERE uid=?', scope.uid).toArray()[0], baseCurrency = row?.base_currency ?? 'CNY', revision = String(row?.revision ?? 0);
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    return { baseCurrency, editVersion: billVersion({ uid: scope.uid, baseCurrency, revision }), source: row ? 'qianji' : 'default', freshness: { revision: `accounting:${revision}`, complete: !!row, stale: !row || !connected || clock.nowMs() - row.validated_ms >= 60_000 || repository.hasUncertainty(scope, 'books'), syncedAt: row ? new Date(row.validated_ms).toISOString() : null } };
  }
  /** Receives only an official userconfigs object, or the successful typed set target. */
  applyOfficial(scope: ActorScope, config: WireJson | undefined): void {
    if (config === undefined || config === null) return;
    const raw = asBillObject(config), prior = this.read(scope), value = raw.basecur === undefined ? prior.baseCurrency : baseCurrencySchema.safeParse(raw.basecur);
    const baseCurrency = typeof value === 'string' ? value : value.success ? value.data : assetError('ACCOUNTING_CONFIG_INVALID', '钱迹返回的本位币配置无法识别');
    this.dependencies.repository.sql.exec('INSERT INTO accounting_config(uid,base_currency,revision,validated_ms) VALUES (?,?,1,?) ON CONFLICT(uid) DO UPDATE SET base_currency=excluded.base_currency,revision=accounting_config.revision+CASE WHEN accounting_config.base_currency<>excluded.base_currency THEN 1 ELSE 0 END,validated_ms=excluded.validated_ms', scope.uid, baseCurrency, this.dependencies.clock.nowMs()).toArray();
  }
}
export function createAccountingConfigurationHandler(dependencies: { configuration: AccountingConfiguration; reconcileSource?: () => Promise<boolean> }): MutationHandler {
  return {
    prepare: async (command, ctx) => {
      const input = baseCurrencyInputSchema.parse(restoreBillInput(command.input)), current = dependencies.configuration.read(command.scope);
      if (current.editVersion !== input.expectedVersion) return assetError('DRAFT_SOURCE_CHANGED', '本位币配置已变化，请重新查看');
      if(current.baseCurrency!==input.baseCurrency){const pending=ctx.repository.sql.exec<{state:string;items:string}>("SELECT state,items FROM operations WHERE uid=? AND (action LIKE 'ledger.%' OR action LIKE 'assets.%' OR action LIKE 'debt.%' OR action LIKE 'budget.%' OR action LIKE 'repeat.%' OR action LIKE 'installments.%' OR action LIKE 'savings.%') AND state IN('queued','sending','verifying','uncertain','partial')",command.scope.uid).toArray();if(pending.some(row=>row.state!=='partial'||(JSON.parse(row.items) as {state:string}[]).some(item=>!['succeeded','failed'].includes(item.state))))return assetError('PENDING_FINANCIAL_OPERATIONS','还有在途或待核查的财务操作，请先核清原操作再切换本位币');}
      const id = `currency:${command.requestId}`, affectedIds = ['accounting:base-currency'];
      return { payload: { scope: { ...command.scope }, id, desired: input.baseCurrency, preparedAt: String(ctx.clock.nowMs()) }, items: [{ id, affectedIds }], affectedIds, affectedDomains: ['books', 'assets', 'ledger', 'budget', 'debt','repeat','installments','savings'] };
    },
    send: async (prepared, ctx) => { const p = asBillObject(prepared.payload), s = asBillObject(p.scope), scope = { uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }; return ctx.client.request('user.configure', { uid: scope.uid, v: stringifyWire({ basecur: p.desired! }) }, scope); },
    applyReceipt: (prepared) => { const p = asBillObject(prepared.payload), s = asBillObject(p.scope); dependencies.configuration.applyOfficial({ uid: String(s.uid), connectionEpoch: String(s.connectionEpoch) }, { basecur: p.desired! }); return { items: [{ id: String(p.id), state: 'succeeded' }] }; },
    reconcile: async (operation) => {
      if (!operation.prepared || !await dependencies.reconcileSource?.()) return { items: [] };
      const p = asBillObject(operation.prepared.payload), current = dependencies.configuration.read(operation.scope);
      if (current.source !== 'qianji' || !current.freshness.syncedAt || Date.parse(current.freshness.syncedAt) < Number(numericText(p.preparedAt, '0')) || current.baseCurrency !== p.desired) return { items: [] };
      return { items: [{ id: String(p.id), state: 'succeeded' }] };
    },
  };
}
