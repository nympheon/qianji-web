import { describe, expect, it } from 'vitest';
import { addMoney, subtractMoney, multiplyMoney, divideMoney, roundMoney, validateMoney, newBillId } from '../../src/shared/numbers';
import vectors from '../../fixtures/apk-454/numeric-cases.json';

describe('decimal accounting values', () => {
  it.each(vectors.additions)('adds $a and $b without binary rounding', ({ a, b, expected }) => {
    expect(addMoney(a, b)).toBe(expected);
  });

  it('does not round intermediate accounting values to two decimals', () => {
    expect(subtractMoney('100', '0.001')).toBe('99.999');
    expect(multiplyMoney('123.456', '0.01')).toBe('1.23456');
    expect(divideMoney('1', '3')).toBe('0.3333333333');
    expect(roundMoney('-1.005', 2)).toBe('-1.01');
  });

  it('enforces an explicit field scale instead of silently rounding input', () => {
    expect(validateMoney('1.2300', { maxScale: 4 })).toBe('1.2300');
    expect(() => validateMoney('1.001', { maxScale: 2 })).toThrow('INVALID_MONEY_SCALE');
    expect(() => validateMoney('1e3', { maxScale: 2 })).toThrow('INVALID_MONEY');
    expect(() => validateMoney('NaN', { maxScale: 2 })).toThrow('INVALID_MONEY');
    expect(() => validateMoney('100', { maxScale: 2, maxAbs: '99' })).toThrow('MONEY_OUT_OF_RANGE');
    expect(() => divideMoney('1', '0')).toThrow('DIVISION_BY_ZERO');
  });

  it('builds six-digit-suffix IDs entirely with integer arithmetic', () => {
    expect(newBillId(1792000000123n, 100000)).toBe('1792000000123100000');
    expect(newBillId(1792000000123n, 999999)).toBe('1792000000123999999');
    expect(() => newBillId(1792000000123n, 99999)).toThrow('INVALID_ID_SUFFIX');
    expect(() => newBillId(-1n, 100000)).toThrow('INVALID_ID_TIME');
  });
});
