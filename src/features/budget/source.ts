import { createHash } from 'node:crypto';
import type { OperationContext } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { ResourceCache, type CacheKey } from '../../storage/cache';
import { asBillObject, moneyText, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import { type WireJson } from '../../shared/wire-json';
import { assetError } from '../assets/model';
import { addMoney } from '../../shared/numbers';
import { businessRange } from '../../shared/dates';
import type { BudgetQuery, BudgetConfiguration, BudgetDay } from './contract';
export function budgetRange(input: BudgetQuery) { if (input.range === 'q' || input.range === 'all') return assetError('BUDGET_RANGE_UNVERIFIED', '此账本周期的独立预算口径尚未核对，请使用已确认的月度或年度预算周期'); const day = /^m(\d+)$/.exec(input.range); return businessRange(input.date, { monthStartDay: day ? Number(day[1]) : 1 }, input.zone); }
export function budgetTypeInfo(input: BudgetQuery) { return input.date.kind === 'month' ? `${input.date.year},${input.date.month}` : String(input.date.year); }
export function budgetParams(scope: ActorScope, input: BudgetQuery): BillObject { budgetRange(input); return { uid: scope.uid, bookid: input.bookId, flts: JSON.stringify({ [input.date.kind]: budgetTypeInfo(input) }), ...(input.range ? { range: input.range } : {}) }; }
export function budgetKey(input: BudgetQuery): CacheKey { const hash = createHash('sha256').update(JSON.stringify([input.bookId, input.date.kind, budgetTypeInfo(input), input.range, input.zone])).digest('hex'); return { domain: 'budget', queryKey: `budget:${hash}`, resourceKind: 'budget' }; }
export function parseBudgets(data: WireJson, input: BudgetQuery): { raw: BillObject; list: BillObject[]; configurations: BudgetConfiguration[]; dayStats: BudgetDay[] | null; editVersion: string } {
  const raw = asBillObject(data); if (!Array.isArray(raw.list) || raw.list.length > 2000 || raw.hasmore === true || numericText(raw.hasmore, '0') === '1') return assetError('BUDGET_SOURCE_INCOMPLETE', '预算来源未完整返回'); const seen = new Set<string>(), list = raw.list.map(asBillObject);
  const configurations = list.map((item): BudgetConfiguration => {
    const flag = numericText(item.flag, '2'), categoryId = flag === '1' ? null : positiveBillId(item.cateid), key = categoryId ?? 'total';
    if (!['1', '2'].includes(flag) || flag === '2' && !categoryId || seen.has(key) || item.bookid !== undefined && numericText(item.bookid, '') !== input.bookId || item.type !== undefined && numericText(item.type, '') !== (input.date.kind === 'month' ? '1' : '2') || item.typeinfo !== undefined && item.typeinfo !== budgetTypeInfo(input)) return assetError('BUDGET_SCOPE_INVALID', '预算集合包含重复或其他账本、周期、日期的配置'); seen.add(key);
    const count = Number(numericText(item.count, '0')); if (!Number.isSafeInteger(count) || count < 0) return assetError('BUDGET_RESPONSE_INVALID', '预算账单数量无法核对'); const category = item.category == null ? null : asBillObject(item.category);
    return { id: positiveBillId(item.budgetid), categoryId, categoryName: category && typeof category.name === 'string' ? category.name : null, limit: moneyText(item.money), officialUsed: moneyText(item.used), officialCount: count };
  });
  if (raw.daystats != null && (!Array.isArray(raw.daystats) || raw.daystats.length > 400)) return assetError('BUDGET_DAYSTATS_INVALID', '预算每日统计格式无法核对');
  const dayStats = Array.isArray(raw.daystats) ? raw.daystats.map((value): BudgetDay => { const row = asBillObject(value), timeSec = Number(numericText(row.datetime, '')); if (!Number.isSafeInteger(timeSec)) return assetError('BUDGET_DAYSTATS_INVALID', '预算每日统计缺少秒时间'); return { timeSec, spend: moneyText(row.spend), totalSpend: moneyText(row.totalspend) }; }) : null;
  const editVersion = createHash('sha256').update(JSON.stringify([budgetKey(input).queryKey, configurations.map(({ id, categoryId, limit }) => [id, categoryId, addMoney(limit)]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))] )).digest('hex'); return { raw, list, configurations, dayStats, editVersion };
}
export function publishBudget(ctx: Pick<OperationContext, 'repository' | 'clock'>, scope: ActorScope, input: BudgetQuery, data: WireJson) { const value = parseBudgets(data, input), cache = new ResourceCache(ctx.repository, ctx.clock), key = budgetKey(input), stamp = cache.captureRead(scope, key); if (cache.applyRead(stamp, { items: [{ id: key.queryKey, kind: 'budget', raw: value.raw }], complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '预算发布期间发生变化'); return value; }
export async function refreshBudget(ctx: Pick<OperationContext, 'repository' | 'clock' | 'client'>, scope: ActorScope, input: BudgetQuery) { const cache = new ResourceCache(ctx.repository, ctx.clock), key = budgetKey(input), stamp = cache.captureRead(scope, key), reply = await ctx.client.request('budget.list', budgetParams(scope, input), scope), value = parseBudgets(reply.data, input); if (cache.applyRead(stamp, { items: [{ id: key.queryKey, kind: 'budget', raw: value.raw }], complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '预算读取期间发生变化，请重新查看'); return value; }
