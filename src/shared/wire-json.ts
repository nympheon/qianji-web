import { isLosslessNumber, parse, stringify } from 'lossless-json';
import type { LosslessNumber } from 'lossless-json';
import { DomainError } from './errors';
import type { Id } from './model';

export type WireJson = null | boolean | string | number | LosslessNumber
  | WireJson[] | { [key: string]: WireJson | undefined };

export function parseWire(text: string): WireJson {
  try {
    return parse(text) as WireJson;
  } catch {
    throw new DomainError('INVALID_JSON', '无法解析上游数据');
  }
}

function validate(value: unknown, ancestors: Set<object>): void {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new DomainError('UNSAFE_WIRE_NUMBER', '请使用无损数值');
    return;
  }
  if (isLosslessNumber(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new DomainError('INVALID_WIRE_VALUE', '无法编码请求数据');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validate(item, ancestors);
  } else {
    for (const item of Object.values(value)) validate(item, ancestors);
  }
  ancestors.delete(value);
}

export function stringifyWire(value: WireJson): string {
  validate(value, new Set());
  const text = stringify(value);
  if (text === undefined) throw new DomainError('INVALID_WIRE_VALUE', '无法编码请求数据');
  return text;
}

export function wireId(value: WireJson): Id {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isLosslessNumber(value) && /^-?(0|[1-9]\d*)$/.test(value.value)) return value.value;
  throw new DomainError('INVALID_ID', '业务ID无效');
}
