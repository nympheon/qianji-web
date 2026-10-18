import { Decimal } from 'decimal.js';
import { DomainError } from './errors';
import type { Id, Money } from './model';

const AccountingDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -1000, toExpPos: 1000 });
const decimalText = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function decimal(value: Money): Decimal {
  if (!decimalText.test(value)) throw new DomainError('INVALID_MONEY', '金额必须是十进制文本');
  return new AccountingDecimal(value);
}

export interface MoneyConstraints { maxScale: number; maxAbs?: Money }

export function validateMoney(value: Money, constraints: MoneyConstraints): Money {
  const parsed = decimal(value);
  if (!Number.isSafeInteger(constraints.maxScale) || constraints.maxScale < 0) {
    throw new DomainError('INVALID_MONEY_CONSTRAINT', '金额校验配置无效');
  }
  const scale = value.split('.')[1]?.length ?? 0;
  if (scale > constraints.maxScale) throw new DomainError('INVALID_MONEY_SCALE', '金额精度超出该字段允许范围');
  if (constraints.maxAbs !== undefined && parsed.abs().greaterThan(decimal(constraints.maxAbs))) {
    throw new DomainError('MONEY_OUT_OF_RANGE', '金额超出该字段允许范围');
  }
  return value;
}

export function addMoney(...values: Money[]): Money {
  return values.reduce((total, value) => total.plus(decimal(value)), new AccountingDecimal(0)).toFixed();
}

export function subtractMoney(a: Money, b: Money): Money { return decimal(a).minus(decimal(b)).toFixed(); }
export function multiplyMoney(a: Money, b: Money): Money { return decimal(a).times(decimal(b)).toFixed(); }

export function divideMoney(a: Money, b: Money): Money {
  const divisor = decimal(b);
  if (divisor.isZero()) throw new DomainError('DIVISION_BY_ZERO', '金额除数不能为零');
  return decimal(a).dividedBy(divisor).toDecimalPlaces(10, Decimal.ROUND_HALF_UP).toFixed();
}

export function roundMoney(value: Money, scale: number): Money {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100) throw new DomainError('INVALID_MONEY_SCALE', '金额精度无效');
  return decimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).toFixed();
}

export function newBillId(nowMs: bigint, suffix: number): Id {
  if (nowMs < 0n) throw new DomainError('INVALID_ID_TIME', '账单ID时间无效');
  if (!Number.isSafeInteger(suffix) || suffix < 100000 || suffix > 999999) {
    throw new DomainError('INVALID_ID_SUFFIX', '账单ID随机部分无效');
  }
  return (nowMs * 1_000_000n + BigInt(suffix)).toString();
}
