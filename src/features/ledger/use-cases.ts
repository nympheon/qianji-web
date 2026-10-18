import { DomainError } from '../../shared/errors';
import { billFilterSchema } from './contract';
import type { LedgerService } from './service';

export function listBills(service: LedgerService, input: unknown) {
  const parsed = billFilterSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('INVALID_BILL_FILTER', '账单筛选参数无效');
  return service.list(parsed.data);
}
