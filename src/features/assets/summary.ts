import { asBillObject, moneyText, numericText, type BillObject } from '../../shared/bill-wire';
import { addMoney, compareMoney, subtractMoney } from '../../shared/numbers';
import type { AssetCurrencySummary, AssetSummary } from './contract';
export function nativeInstallmentMoney(raw: BillObject): { money: string; complete: boolean } {
  let money = '0', complete = true;
  if (Array.isArray(raw.installs)) for (const value of raw.installs) {
    const item = asBillObject(value);
    if (numericText(item.incount, '0') !== '1' || numericText(item.status, '0') !== '1') continue;
    if (item.data == null) { complete = false; continue; }
    money = addMoney(money, moneyText(item.money), numericText(asBillObject(item.data).feeincount, '0') === '1' ? moneyText(item.fee) : '0');
  }
  return { money, complete };
}
export function summarizeAssets(assets: BillObject[], includeInstallments: boolean, baseCurrency = 'CNY'): AssetSummary {
  const currencies = new Map<string, AssetCurrencySummary>(), reasons = new Set<string>();
  for (const raw of assets) {
    const type = Number(numericText(raw.type, '-1')), subtype = Number(numericText(raw.stype, '-1'));
    if (type === 6 || numericText(raw.incount, '0') !== '1') continue;
    if (![1, 2, 3, 4, 5].includes(type)) { reasons.add('UNKNOWN_ASSET_TYPE'); continue; }
    const currency = typeof raw.currency === 'string' && raw.currency ? raw.currency : baseCurrency;
    const row = currencies.get(currency) ?? { currency, assets: '0', liabilities: '0', borrowed: '0', lent: '0', net: '0', installments: '0' };
    let value = moneyText(raw.money), installmentMoney = '0';
    if (type === 2 && Array.isArray(raw.installs)) {
      const calculated = nativeInstallmentMoney(raw); installmentMoney = calculated.money; if (!calculated.complete) reasons.add('INSTALLMENT_DATA_MISSING');
      if (includeInstallments) value = subtractMoney(value, installmentMoney);
    }
    if (type === 5) {
      if (subtype === 51) { value = compareMoney(value, '0') <= 0 ? value : '0'; row.borrowed = addMoney(row.borrowed, value); }
      else if (subtype === 52) { value = compareMoney(value, '0') > 0 ? value : '0'; row.lent = addMoney(row.lent, value); row.assets = addMoney(row.assets, value); }
      else { reasons.add('UNKNOWN_DEBT_DIRECTION'); continue; }
    } else if (type === 2) {
      if (compareMoney(value, '0') <= 0) row.liabilities = addMoney(row.liabilities, value); else row.assets = addMoney(row.assets, value);
      row.installments = addMoney(row.installments, installmentMoney);
    } else row.assets = addMoney(row.assets, value);
    row.net = addMoney(row.net, value); currencies.set(currency, row);
  }
  return { currencies: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)), complete: reasons.size === 0, incompleteReasons: [...reasons] };
}
