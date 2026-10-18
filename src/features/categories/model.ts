import { asBillObject, numericText, positiveBillId, type BillObject } from '../../shared/bill-wire';
import type { WireJson } from '../../shared/wire-json';
import type { CategoryListInput, CategoryView } from './contract';
import { assetError } from '../assets/model';
import { billVersion } from '../ledger/write';
export function categoryView(raw: BillObject, all: BillObject[] = []): CategoryView {
  const id = positiveBillId(raw.id), type = numericText(raw.type, '0'), level = numericText(raw.level, '1');
  if (!id || !['0', '1'].includes(type) || !['1', '2'].includes(level) || typeof raw.name !== 'string') return assetError('CATEGORY_RESPONSE_INVALID', '分类的ID、名称、类型或层级无法核对');
  return { id, bookId: numericText(raw.bookid, '-1'), type: type === '0' ? 0 : 1, name: raw.name, parentId: positiveBillId(raw.parentid), level: level === '1' ? 1 : 2, sort: Number(numericText(raw.sort, '50')), editable: numericText(raw.editable, '1') === '1', icon: typeof raw.icon === 'string' ? raw.icon : '', childIds: all.filter((child) => positiveBillId(child.parentid) === id).map((child) => numericText(child.id, '')), editVersion: billVersion(raw) };
}
export function flattenCategories(values: WireJson[], input: CategoryListInput): BillObject[] {
  const result: BillObject[] = [], seen = new Set<string>();
  function add(value: WireJson, parent: string | null) {
    const raw = asBillObject(value), view = categoryView(raw);
    if (seen.has(view.id) || view.type !== input.type || ![input.bookId, '-1'].includes(view.bookId) || view.parentId !== parent || (parent ? view.level !== 2 : view.level !== 1)) return assetError('CATEGORY_SCOPE_INVALID', '分类树包含重复、错位或其他账本/类型的分类');
    seen.add(view.id); result.push(raw);
    if (raw.sublist !== undefined && raw.sublist !== null && !Array.isArray(raw.sublist)) return assetError('CATEGORY_TREE_INVALID', '子分类列表格式无法核对');
    if (Array.isArray(raw.sublist)) { if (parent && raw.sublist.length) return assetError('CATEGORY_LEVEL_UNSUPPORTED', '分类树超过APK的两级层次'); for (const child of raw.sublist) add(child, view.id); }
    if (result.length > 5000) return assetError('CATEGORY_SOURCE_LIMIT', '分类来源超过本次可完整核对的5000项，请缩小范围');
  }
  values.forEach((value) => add(value, null)); return result;
}
export function categoryCounts(raw: BillObject) {
  const count = Number(numericText(raw.count, '0')), other = Number(numericText(raw.other, '0'));
  if (![count, other].every((value) => Number.isSafeInteger(value) && value >= 0)) return assetError('CATEGORY_CHECK_INVALID', '官方分类引用计数无法核对'); return { count, other };
}
