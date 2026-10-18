import { parseWire } from '../../src/shared/wire-json';
import type { BillRecord, MirrorPage } from '../../src/storage/mirror';

export function bill(overrides: Partial<BillRecord> = {}): BillRecord {
  return {
    id: '1792000000123100000', bookId: '10', type: 0, timeSec: 1792000000, money: '0.1',
    raw: parseWire('{"id":1792000000123100000,"future":{"n":9007199254740993,"encoded":"{\\"id\\":9007199254740993}"}}'),
    relations: [{ kind: 'refund', targetId: '1792000000123100001', raw: { futureFlag: true } }],
    ...overrides,
  };
}
export function page(overrides: Partial<MirrorPage> = {}): MirrorPage {
  return { upserts: [bill()], deletes: [], resources: [], pageState: { next: 'p2' }, ...overrides };
}
