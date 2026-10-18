import { DomainError } from '../../shared/errors';
import { syncInputSchema } from './contract';
import type { SyncService } from './service';

export function startSync(service: SyncService, input: unknown) {
  const parsed = syncInputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('INVALID_SYNC_INPUT', '同步参数无效');
  return service.start(parsed.data);
}
