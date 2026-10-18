import { describe, expect, it } from 'vitest';
import { parseWire, stringifyWire, wireId } from '../../src/shared/wire-json';
import type { WireJson } from '../../src/shared/wire-json';

describe('lossless protocol JSON', () => {
  it('round-trips long integer IDs, decimals and unknown nested fields', () => {
    const text = '{"billid":1792000000123100000,"money":0.10000000000000000000001,"unknown":{"ids":[-1,1792000000123999999]}}';
    expect(stringifyWire(parseWire(text))).toBe(text);
  });

  it('does not reinterpret embedded JSON strings or string plan IDs', () => {
    const record = parseWire('{"id":"plan-A","extra":"{\\"ref\\":1792000000123100000}"}') as { [key: string]: WireJson };
    expect(wireId(record.id!)).toBe('plan-A');
    expect(record.extra).toBe('{"ref":1792000000123100000}');
    expect(wireId(parseWire('1792000000123100000'))).toBe('1792000000123100000');
    expect(wireId(parseWire('-1'))).toBe('-1');
  });

  it('keeps omission, explicit null and numeric zero distinct', () => {
    expect(stringifyWire({ omitted: undefined, cleared: null, zero: parseWire('0') })).toBe('{"cleared":null,"zero":0}');
  });

  it('rejects already-rounded JavaScript numbers at the wire boundary', () => {
    expect(() => stringifyWire({ id: 1792000000123100000 } as unknown as WireJson)).toThrow('UNSAFE_WIRE_NUMBER');
    expect(() => stringifyWire({ value: Number.POSITIVE_INFINITY } as unknown as WireJson)).toThrow('UNSAFE_WIRE_NUMBER');
  });

  it('does not echo malformed input or accept noninteger numeric IDs', () => {
    expect(() => parseWire('{"pwd":"secret')).toThrow('INVALID_JSON');
    expect(() => parseWire('{"pwd":"secret')).not.toThrow('secret');
    expect(() => wireId(parseWire('1.5'))).toThrow('INVALID_ID');
    expect(() => wireId('')).toThrow('INVALID_ID');
  });
});
