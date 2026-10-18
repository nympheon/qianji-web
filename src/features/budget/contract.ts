import type { BillDetail } from '../ledger/contract';
import type { Id, Money, TimeRange } from '../../shared/model';
export interface BudgetDefinition { id: Id; categoryId: Id | null; limit: Money }
export interface BudgetCalculationInput { bills: BillDetail[]; budgets: BudgetDefinition[]; categories: { id: Id; parentId: Id | null }[]; currency: Id; range: TimeRange; nowSec: number }
export interface BudgetProgressRow extends BudgetDefinition { used: Money; count: number; remaining: Money; ratio: Money | null }
export interface BudgetProgress { used: Money; totalNotBudget: Money; rows: BudgetProgressRow[]; remainingDays: number; incompleteReasons: string[]; warnings: string[] }
