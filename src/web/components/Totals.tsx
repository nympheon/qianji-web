import { roundMoney } from '../../shared/numbers';
import type { StatSummary } from '../../features/ledger/statistics';
export function formatMoney(money: string): string {
  const [integer, decimal] = roundMoney(money, 2).split('.');
  return `${integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(decimal ?? '').padEnd(2, '0')}`;
}
export function Totals({ totals, currency = 'CNY' }: { totals: StatSummary | null; currency?: string }) {
  const symbol = currencySymbol(currency);
  return <section className="totals" aria-label="收支汇总">{([['spend', '支出', totals?.totalSpend], ['income', '收入', totals?.totalIncome], ['balance', '结余', totals?.balance]] as const).map(([kind, label, value]) => <div key={kind}><span>{label}</span><strong className={`money-${kind}`} data-testid={`total-${kind}`}>{value !== undefined ? `${symbol} ${formatMoney(value)}` : '—'}</strong></div>)}</section>;
}
export function currencySymbol(currency: string) { return currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency; }
