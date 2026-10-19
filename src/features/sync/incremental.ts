import { isLosslessNumber } from 'lossless-json';
import { DomainError } from '../../shared/errors';
import { parseWire, wireId, type WireJson } from '../../shared/wire-json';
import type { WireObject } from '../../protocol/signer';
import type { BillRecord } from '../../storage/mirror';
import type { ResourceRecord } from '../../storage/resources';
import type { SyncCheckpoint } from './contract';
import { billLinks, moneyText } from '../../shared/bill-wire';

export function invalidSync(): never { throw new DomainError('SYNC_RESPONSE_INVALID', '同步响应结构发生变化，保留现有数据及成功游标'); }
export function wireObject(value: WireJson | undefined): WireObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value)) return invalidSync();
  return value;
}
export function integerText(value: WireJson | undefined): string {
  const result = typeof value === 'string' ? value : isLosslessNumber(value) ? value.value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!/^-?(0|[1-9]\d*)$/.test(result)) return invalidSync();
  return result;
}
function safeInteger(value: WireJson | undefined): number {
  const number = Number(integerText(value));
  if (!Number.isSafeInteger(number)) return invalidSync();
  return number;
}
function list(value: WireJson | undefined): WireJson[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : invalidSync();
}
function id(value: WireJson | undefined): string { try { return wireId(value ?? null); } catch { return invalidSync(); } }
export function projectBill(value: WireJson): BillRecord {
  const raw = wireObject(value);
  if (raw.money === undefined || raw.money === null) return invalidSync();
  const money = moneyText(raw.money);
  return { id: id(raw.id), bookId: integerText(raw.bookid), type: safeInteger(raw.type), timeSec: safeInteger(raw.time), money, raw: value, relations: billLinks(raw) };
}
export interface LedgerPage {
  bills: BillRecord[]; deletes: string[]; resources: ResourceRecord[];
  next: { bookId: string; pageOffset: string; pageSign: string }; hasMore: boolean; lastTimes: WireObject;
}
export function parseLedgerPage(data: WireJson): LedgerPage {
  const raw = wireObject(data), more = integerText(raw.hasmore), count = safeInteger(raw.count);
  if ((more !== '0' && more !== '1') || count < 0 || typeof raw.pagesign !== 'string') return invalidSync();
  const bills = list(raw.changes).map(projectBill);
  const categories = new Map<string, ResourceRecord>();
  for (const category of [...list(raw.categories), ...bills.map((bill) => wireObject(bill.raw).category).filter((value): value is WireJson => value !== undefined && value !== null)]) {
    const object = wireObject(category), categoryId = id(object.id);
    categories.set(categoryId, { id: categoryId, kind: 'category', raw: category });
  }
  return { bills, deletes: list(raw.deletes).map(id), resources: [...categories.values()],
    next: { bookId: integerText(raw.bookid), pageOffset: integerText(raw.pageoffset), pageSign: raw.pagesign },
    hasMore: more === '1', lastTimes: raw.lasttimes == null ? {} : wireObject(raw.lasttimes) };
}
export function parseTagPage(data: WireJson) {
  const raw = wireObject(data);
  if (typeof raw.hasmore !== 'boolean') return invalidSync();
  const resources = list(raw.update).map((value): ResourceRecord => ({ id: id(wireObject(value).id), kind: 'tag', raw: value }));
  return { resources, deletes: list(raw.delete).map((value) => ({ id: id(value), kind: 'tag' as const })), hasMore: raw.hasmore };
}
/** tag/list is a separate grouped catalog source, never inferred from tag/syncall. */
export function parseTagGroups(data: WireJson): ResourceRecord[] {
  if (!Array.isArray(data)) return invalidSync();
  const result: ResourceRecord[] = [];
  for (const value of data) {
    const group = wireObject(value);
    if (group.id !== '') result.push({ id: id(group.id), kind: 'tagGroup', raw: value });
    for (const tag of list(group.tags)) result.push({ id: id(wireObject(tag).id), kind: 'tag', raw: tag });
  }
  return result;
}

export function parseCheckpoint(text: string): SyncCheckpoint {
  try {
    const raw = wireObject(parseWire(text)), scope = wireObject(raw.scope);
    const tagPage = safeInteger(raw.tagPage);
    if (typeof scope.uid !== 'string' || !scope.uid || typeof scope.connectionEpoch !== 'string' || !scope.connectionEpoch
      || typeof raw.datasetId !== 'string' || !raw.datasetId || typeof raw.pageSign !== 'string'
      || typeof raw.full !== 'boolean' || tagPage < 0 || tagPage > 40
      || (raw.ownerJobId !== undefined && (typeof raw.ownerJobId !== 'string' || raw.ownerJobId.length === 0))
      || (raw.prerequisiteTagJobId!==undefined&&(typeof raw.prerequisiteTagJobId!=='string'||!raw.prerequisiteTagJobId))
      || raw.startCursor === undefined || raw.collectedTimes === undefined) return invalidSync();
    return { scope: { uid: scope.uid, connectionEpoch: scope.connectionEpoch }, datasetId: raw.datasetId,
      startCursor: raw.startCursor, collectedTimes: wireObject(raw.collectedTimes),
      bookId: integerText(raw.bookId), pageOffset: integerText(raw.pageOffset), pageSign: raw.pageSign, tagPage, full: raw.full,
      ...(typeof raw.ownerJobId === 'string' ? { ownerJobId: raw.ownerJobId } : {}),
      ...(typeof raw.prerequisiteTagJobId==='string'?{prerequisiteTagJobId:raw.prerequisiteTagJobId}:{}) };
  } catch { return invalidSync(); }
}
