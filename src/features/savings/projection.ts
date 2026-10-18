import { LosslessNumber } from 'lossless-json';
import { Decimal } from 'decimal.js';
import { addMoney, compareMoney, multiplyMoney, subtractMoney } from '../../shared/numbers';
import { DomainError } from '../../shared/errors';
import { businessTimeSec } from '../../shared/local-time';
import type { BillObject } from '../../shared/bill-wire';
import { savingsRuleSchema, type SavingsProjection } from './contract';
import type { z } from 'zod';
type RuleInput = z.input<typeof savingsRuleSchema>;
const Exact = Decimal.clone({precision:100});
export function savingsRuleWire(input: RuleInput): BillObject {
  const rule=savingsRuleSchema.parse(input), start=businessTimeSec(rule.startDate,rule.time,rule.zone); if(start<=0)throw new DomainError('SAVINGS_DATE_INVALID','计划开始日期必须晚于1970年');
  if(rule.mode==='custom') {if(compareMoney(rule.total,'0')<=0 || rule.endDate && rule.endDate<rule.startDate)throw new DomainError('SAVINGS_RULE_INVALID','目标金额必须大于零，结束日期不能早于开始日期');return {mode:rule.mode,total:new LosslessNumber(rule.total),start,end:rule.endDate?businessTimeSec(rule.endDate,rule.time,rule.zone):0};}
  if('amount'in rule) {if(compareMoney(rule.amount,'0')<=0)throw new DomainError('SAVINGS_RULE_INVALID','每期金额必须大于零');return {mode:rule.mode,amount:new LosslessNumber(rule.amount),start,period:rule.mode==='fixedAmount'?rule.period:rule.mode==='fixedAmount12'?12:36,frequency:rule.mode==='fixedAmount'?rule.frequency:'month'};}
  if(compareMoney(rule.initialAmount,'0')<=0 || compareMoney(rule.increment,'0')<0)throw new DomainError('SAVINGS_RULE_INVALID','首期金额必须大于零，递增值不能为负数');return {mode:rule.mode,initialAmount:new LosslessNumber(rule.initialAmount),increment:new LosslessNumber(rule.increment),start,period:rule.mode==='daily365'?365:52};
}
/** Calendar.add clamps month/year changes successively; this differs from installment Calendar.set. */
function advance(date:Date,unit:string) { if(unit==='day'||unit==='week'){date.setUTCDate(date.getUTCDate()+(unit==='day'?1:7));return;}const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+(unit==='quarter'?3:unit==='year'?12:1));const end=new Date(date);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);date.setUTCDate(Math.min(day,end.getUTCDate())); }
export function projectSavings(input:RuleInput,limit=120):SavingsProjection {
  const rule=savingsRuleSchema.parse(input), wire=savingsRuleWire(rule);if(!Number.isSafeInteger(limit)||limit<1||limit>120)throw new DomainError('SAVINGS_PREVIEW_LIMIT','预览最多120期');
  if(rule.mode==='custom')return {rows:[],totalAmount:rule.total,periods:null,complete:true,kind:'flexible-target'};
  const periods=Number(wire.period),rows:SavingsProjection['rows']=[],date=new Date(rule.startDate+'T00:00:00Z');let total:string,frequency:string;
  if('amount'in rule){total=multiplyMoney(rule.amount,String(periods));frequency=rule.mode==='fixedAmount'?rule.frequency:'month';}
  else {frequency=rule.mode==='daily365'?'day':'week';if(rule.mode==='reverseWeekly52'){const terms=compareMoney(rule.increment,'0')===0?periods:Math.min(periods,new Exact(rule.initialAmount).div(rule.increment).ceil().toNumber());total=subtractMoney(multiplyMoney(rule.initialAmount,String(terms)),multiplyMoney(rule.increment,String(terms*(terms-1)/2)));}else total=addMoney(multiplyMoney(rule.initialAmount,String(periods)),multiplyMoney(rule.increment,String(periods*(periods-1)/2)));}
  for(let i=0;i<Math.min(periods,limit);i++){if(date.getUTCFullYear()>9999)throw new DomainError('SAVINGS_DATE_LIMIT','预览日期超出支持范围');const text=date.toISOString().slice(0,10), amount='amount'in rule?rule.amount:rule.mode==='reverseWeekly52'?Exact.max(0,new Exact(rule.initialAmount).minus(new Exact(rule.increment).times(i))).toFixed():addMoney(rule.initialAmount,multiplyMoney(rule.increment,String(i)));rows.push({period:i+1,date:text,timeSec:businessTimeSec(text,rule.time,rule.zone),amount});advance(date,frequency);}
  return {rows,totalAmount:total,periods,complete:periods<=limit,kind:'schedule'};
}
