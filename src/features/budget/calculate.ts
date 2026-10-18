import type { BudgetCalculationInput, BudgetProgress } from './contract';
import { aggregate, toStatItem } from '../ledger/statistics';
import { addMoney, compareMoney, divideMoney, subtractMoney } from '../../shared/numbers';
import { businessDay } from '../ledger/query';

export function calculateBudget(input: BudgetCalculationInput): BudgetProgress {
  const categories = new Map(input.categories.map((category) => [category.id, category.parentId]));
  const used = new Map<string, { used: string; count: number }>();
  const items = input.bills.map((bill) => ({ bill, item: toStatItem(bill, 'budget', input.currency, input.currency) }));
  let total = '0', totalNotBudget = '0';
  for (const { bill, item } of items) {
    const totalSpend = aggregate([item]).totalSpend;
    const categoryEligible = [0, 5, 10].includes(bill.type), transfer = bill.type === 2 || bill.type === 3;
    if (!categoryEligible && !transfer) continue;
    if (compareMoney(totalSpend, '0') > 0) total = addMoney(total, totalSpend);
    if (!categoryEligible) continue;
    if (compareMoney(item.totalFlagBudget, '0') > 0) totalNotBudget = addMoney(totalNotBudget, item.totalFlagBudget);
    const id = bill.categoryId ?? '-1', parent = categories.get(id);
    for (const category of new Set([id, ...(parent && parent !== '-1' && parent !== '0' ? [parent] : [])])) {
      const previous = used.get(category) ?? { used: '0', count: 0 };
      used.set(category, { used: compareMoney(totalSpend, '0') > 0 ? addMoney(previous.used, totalSpend) : previous.used, count: previous.count + 1 });
    }
  }
  const all = aggregate(items.map(({ item }) => item));
  const ordinal = (seconds: number) => Date.parse(`${businessDay(seconds, input.range.zone)}T00:00:00Z`) / 86_400_000;
  return { used: total, totalNotBudget, rows: input.budgets.map((budget) => {
    const progress = budget.categoryId === null ? { used: total, count: 0 } : used.get(budget.categoryId) ?? { used: '0', count: 0 };
    return { ...budget, ...progress, remaining: subtractMoney(budget.limit, progress.used), ratio: compareMoney(budget.limit, '0') > 0 ? divideMoney(progress.used, budget.limit) : null };
  }), remainingDays: Math.max(0, ordinal(input.range.endSec) - ordinal(Math.max(input.range.startSec, input.nowSec)) + 1), incompleteReasons: all.incompleteReasons, warnings: all.warnings };
}
