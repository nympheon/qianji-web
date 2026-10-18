import { asBillObject, numericText, type BillObject } from '../../shared/bill-wire';
import { assetError } from '../assets/model';
import { billVersion } from '../ledger/write';
import type { BookDeleteCheck, BookView } from './contract';
import { bookIdSchema } from './contract';
export function validateBook(raw: BillObject, id?: string): BillObject {
  const key = numericText(raw.bookid, ''); if (!bookIdSchema.safeParse(key).success || id !== undefined && key !== id || typeof raw.name !== 'string' || typeof raw.userid !== 'string' || !['0', '1'].includes(numericText(raw.visible, '1'))) return assetError('BOOK_RESPONSE_INVALID', '账本ID、所有者或必要资料无法核对'); return raw;
}
export function bookView(raw: BillObject, uid: string, vipExpired = false): BookView {
  const id = numericText(raw.bookid, ''), ownerId = numericText(raw.userid, ''), memberId = typeof raw.memberid === 'string' && raw.memberid ? raw.memberid : null, role = ownerId === uid ? 'owner' : memberId === uid ? 'member' : 'unknown', config = raw.config == null ? {} : asBillObject(raw.config);
  return { id, name: typeof raw.name === 'string' ? raw.name : '', type: Number(numericText(raw.type, '-1')), visible: numericText(raw.visible, '1') === '1', sort: Number(numericText(raw.sort, '0')), ownerId, memberId, role, defaultBook: id === '-1', expiredAsOwner: id !== '-1' && role === 'owner' && vipExpired, expiredAsMember: role === 'member' && numericText(raw.expired, '0') === '1', memberCount: Number(numericText(raw.membercount, '0')), range: typeof config.range === 'string' ? config.range : '', cover: typeof raw.cover === 'string' ? raw.cover : null, editVersion: billVersion(raw) };
}
export function parseBookDeleteCheck(raw: BillObject): BookDeleteCheck {
  const legacy = raw.owner_has_unresolved === undefined && raw.member_has_unresolved === undefined && numericText(raw.has_unresolved, '0') === '1';
  const ownerHasUnresolved = legacy || numericText(raw.owner_has_unresolved, '0') === '1', memberHasUnresolved = legacy || numericText(raw.member_has_unresolved, '0') === '1';
  return { ownerHasUnresolved, memberHasUnresolved, blocked: ownerHasUnresolved || memberHasUnresolved };
}
