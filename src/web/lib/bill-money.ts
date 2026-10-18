import type { BillSummary } from '../../features/ledger/contract';
/** Ordinary currency.sv is the recorded gross input; raw money can be in the selected asset's currency. */
export function displayedBillMoney(bill:BillSummary,baseCurrency:string){
  if([0,1,5].includes(bill.type)&&bill.currency?.srcSymbol)return {amount:bill.currency.srcValue,currency:bill.currency.srcSymbol,sourceEntry:true};
  return {amount:bill.money,currency:bill.currency?.srcSymbol??baseCurrency,sourceEntry:false};
}
