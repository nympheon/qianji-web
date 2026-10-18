import { expect,it } from 'vitest';
import { displayedBillMoney } from '../../src/web/lib/bill-money';
import { summarizeBill } from '../../src/features/ledger/model';
import { projectBill } from '../../src/features/sync/incremental';
it('does not label an ordinary asset-currency money value with a different source-currency unit',()=>{
  const bill=summarizeBill(projectBill({id:'1',bookid:'1',assetid:'20',type:0,time:1,money:'630',extra:{transfee:'-10',curr:{ss:'USD',sv:'100',ts:'CNY',tv:'630',bs:'CNY',bv:'630'}}}));expect(displayedBillMoney(bill,'CNY')).toEqual({amount:'100',currency:'USD',sourceEntry:true});
});
