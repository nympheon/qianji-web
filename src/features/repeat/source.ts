import {isLosslessNumber} from 'lossless-json';
import { asBillObject, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { addMoney } from '../../shared/numbers';
import { DomainError } from '../../shared/errors';
import { ResourceCache, type CacheKey } from '../../storage/cache';
import type { OperationContext } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { billVersion } from '../ledger/write';
import { repeatFieldsSchema, repeatQuerySchema, type RepeatQuery, type RepeatView, type HolidayYears } from './contract';
import type { WireJson } from '../../shared/wire-json';
export function repeatKey(input: RepeatQuery = {}): CacheKey { const query = repeatQuerySchema.parse(input); return { domain: 'repeat', queryKey: `repeat:list:${query.sort}:${Number(query.ascending)}`, resourceKind: 'repeat' }; }
const integer = (value: WireJson | undefined, fallback = '0') => { const number = Number(numericText(value, fallback)); if (!Number.isSafeInteger(number)) throw new DomainError('REPEAT_RESPONSE_INVALID', '周期任务整数资料无法核对'); return number; };
export function repeatView(raw: BillObject): RepeatView {
  const id = positiveBillId(raw.id); if (!id) throw new DomainError('REPEAT_RESPONSE_INVALID', '周期任务缺少管理ID');
  const data = asBillObject(raw.data), rule = asBillObject(data.repeat), end = data.end == null ? null : asBillObject(data.end), fee = moneyText(data.fee), curr = data.curr == null ? null : asBillObject(data.curr), time = typeof data.time === 'string' ? data.time.split(':').map((part) => part.padStart(2, '0')).join(':') : '00:00';
  const parsed = repeatFieldsSchema.safeParse({ type: integer(raw.type), bookId: numericText(data.bookid, ''), categoryId: positiveBillId(data.cateid), fromAssetId: positiveBillId(data.fromid), targetAssetId: positiveBillId(data.targetid), enteredMoney: addMoney(moneyText(data.money), fee.startsWith('-') ? fee.slice(1) : fee), fee, startDate: data.start, time, repeat: { type: rule.type, values: Array.isArray(rule.value) ? rule.value.map(value=>typeof value==='number'||isLosslessNumber(value)?numericText(value,''):value) : [] }, end: end && typeof end.date === 'string' && end.date ? { kind: 'date', date: end.date } : end && integer(end.count, '-1') > 0 ? { kind: 'count', count: integer(end.count) } : null, remark: typeof data.remark === 'string' ? data.remark : '', tagIds: Array.isArray(data.tags) ? data.tags : [], images: Array.isArray(data.images) ? data.images : [], countInStatistics: !(integer(data.billflag) & 1), countInBudget: !(integer(data.billflag) & 2), currency: curr ? { srcSymbol: curr.ss, srcValue: moneyText(curr.sv), targetSymbol: curr.ts, targetValue: moneyText(curr.tv), baseSymbol: curr.bs, baseValue: moneyText(curr.bv) } : null });
  const dualEnd = end && typeof end.date === 'string' && end.date && integer(end.count, '-1') > 0;
  return { id, packId: positiveBillId(raw.packid), type: integer(raw.type), count: integer(raw.count), status: integer(raw.status), createdAtSec: integer(raw.createtime), fields: parsed.success && !dualEnd ? parsed.data : null, unsupportedReason: !parsed.success || dualEnd ? '此任务包含尚未核对的类型或规则，请先在钱迹客户端查看' : null, editVersion: billVersion({ ...raw, count: 0, status: 0, updatetime: 0, createtime: 0 }) };
}
export async function refreshRepeats(ctx: Pick<OperationContext, 'repository' | 'clock' | 'client'>, scope: ActorScope, input: RepeatQuery = {}): Promise<BillObject[]> {
  const query = repeatQuerySchema.parse(input), key = repeatKey(query), cache = new ResourceCache(ctx.repository, ctx.clock), stamp = cache.captureRead(scope, key), items: { id: string; kind: 'repeat'; raw: BillObject }[] = [], seen = new Set<string>(); let complete = false;
  for (let page = 0; page < 20; page++) { const reply = await ctx.client.request('repeat.list', { uid: scope.uid, page, flts: JSON.stringify({ sort: `${query.sort},${Number(query.ascending)}` }) }, scope); if (!Array.isArray(reply.data)) throw new DomainError('REPEAT_LIST_INVALID', '周期任务列表格式无法核对'); for (const value of reply.data) { const raw = asBillObject(value), view = repeatView(raw); if (seen.has(view.id) || items.length >= 2000 || raw.userid != null && numericText(raw.userid, '') !== scope.uid) throw new DomainError('REPEAT_LIST_INVALID', '周期任务列表包含重复或其他账号对象'); seen.add(view.id); items.push({ id: view.id, kind: 'repeat', raw }); } if (!reply.hasMore) { complete = true; break; } if (!reply.data.length) break; }
  if (!complete) throw new DomainError('REPEAT_LIST_INCOMPLETE', '周期任务分页尚未完整返回');
  ctx.repository.transaction(() => {
    const dataset = ctx.repository.dataset(scope, 'repeat'), previous = dataset ? ctx.repository.sql.exec<{ id: string }>("SELECT id FROM resources WHERE uid=? AND domain='repeat' AND dataset_id=? AND kind='repeat' LIMIT 2001", scope.uid, dataset.id).toArray() : [];
    if (previous.length > 2000) throw new DomainError('REPEAT_LIST_INCOMPLETE', '本地任务目录超出本轮核对范围');
    if (cache.applyRead(stamp, { items, complete: true, deletes: previous.map((row) => row.id).filter((id) => !seen.has(id)) }) !== 'applied') throw new DomainError('SOURCE_SUPERSEDED', '周期任务读取期间发生变化，请重新查看');
    if (ctx.repository.dataset(scope, 'repeat')?.revision !== dataset?.revision) { ctx.repository.bumpSourceGeneration(scope, 'repeat'); ctx.repository.sql.exec("UPDATE source_queries SET invalidated=1 WHERE uid=? AND domain='repeat' AND resource_kind='repeat' AND query_key<>?", scope.uid, key.queryKey).toArray(); }
  }); return items.map((item) => item.raw);
}
export function holidayKey(years: number[]): CacheKey { return { domain: 'repeat', queryKey: `repeat:holidays:${[...new Set(years)].sort().join(',')}`, resourceKind: 'holiday' }; }
export function holidayYears(raw: WireJson): HolidayYears {
  const years = asBillObject(asBillObject(raw).years), result: HolidayYears = {}; for (const [year, value] of Object.entries(years)) { if (!/^\d{4}$/.test(year) || value == null) continue; const days = asBillObject(value), map: HolidayYears[string] = {}; if (Object.keys(days).length > 370) throw new DomainError('HOLIDAYS_INVALID', '年度节假日数据超出范围'); for (const [date, raw] of Object.entries(days)) { if (!date.startsWith(year + '-') || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue; const row = asBillObject(raw); map[date] = { holiday: row.holiday !== false && row.holiday !== 'false' }; } result[year] = map; } return result;
}
