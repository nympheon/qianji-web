import type { BillSummary, StatisticsInput, StatisticsView } from './contract';
import type { StatItem } from './statistics';
import { aggregate } from './statistics';
import { businessDay } from './query';

/** Bounded display dimensions; totals are always computed from the original items once. */
export function statisticsDimensions(bills: BillSummary[], items: StatItem[], input: StatisticsInput, parents: Map<string, string | null>, zone: string) {
  const reasons = new Set<string>(); let groupsRemaining = 1000;
  function grouped(keys: (bill: BillSummary) => string[], categoryParents = false) {
    const groups = new Map<string, StatItem[]>();
    bills.forEach((bill, index) => {
      for (const key of new Set(keys(bill))) {
        if (!groups.has(key)) {
          if (groupsRemaining <= 0) { reasons.add('STATISTICS_GROUP_LIMIT'); continue; }
          groups.set(key, []); groupsRemaining--;
        }
        groups.get(key)!.push(items[index]!);
      }
    });
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, parentId: categoryParents ? parents.get(key) ?? null : null, totals: aggregate(values) }));
  }
  const groups: StatisticsView['groups'] = [...new Set(input.dimensions ?? [])].sort().map((dimension) => ({ dimension, overlapping: ['tag', 'category-tree', 'asset'].includes(dimension), items: grouped((bill) => {
    if (dimension === 'tag') return bill.tagIds.length ? bill.tagIds : ['-1'];
    if (dimension === 'member') return [bill.memberId ?? '-1'];
    if (dimension === 'book') return [bill.bookId];
    if (dimension === 'asset') return [...new Set([bill.assetId, bill.fromId, bill.targetId].filter((id): id is string => id !== null && id !== '-1' && id !== '0'))].length
      ? [bill.assetId, bill.fromId, bill.targetId].filter((id): id is string => id !== null && id !== '-1' && id !== '0') : ['-1'];
    const path = [bill.categoryId ?? '-1'];
    if (dimension === 'category-tree') {
      let parent = parents.get(path[0]!);
      while (parent && parent !== '-1' && parent !== '0') {
        if (path.includes(parent)) { reasons.add('CATEGORY_CYCLE'); break; }
        path.push(parent); parent = parents.get(parent);
      }
    }
    return path;
  }, dimension === 'category' || dimension === 'category-tree') }));
  const trend = grouped((bill) => [businessDay(bill.timeSec, zone).slice(0, input.trend === 'year' ? 4 : input.trend === 'month' ? 7 : 10)]).map(({ key, totals }) => ({ period: key, totals }));
  return { groups, trend, incompleteReasons: [...reasons] };
}
