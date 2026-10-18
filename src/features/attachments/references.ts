import type { OperationContext } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import { asBillObject } from '../../shared/bill-wire';
import { DomainError } from '../../shared/errors';
import { ImageConfiguration } from './configuration';
/** Preserve/remove existing references; new bill keys require confirmed upload evidence. */
export function assertImageReferences(ctx: Pick<OperationContext, 'repository' | 'clock'>, scope: ActorScope, images: readonly string[], previous: readonly string[] = []): string[] {
  const unique = [...new Set(images)], old = new Set(previous), maximum = new ImageConfiguration(ctx).read(scope).maxBillImages;
  if (unique.length > maximum && unique.some((key) => !old.has(key))) throw new DomainError('IMAGE_COUNT_LIMIT', `本次账单图片超过当前配置的${maximum}张限制`);
  for (const key of unique) { if (old.has(key)) continue; const row = ctx.repository.readResources(scope, 'attachment', { domain: 'attachments', ids: [key] }).items[0], raw = row ? asBillObject(row.raw) : null; if (!raw || raw.key !== key || raw.purpose !== 'bill' || !['qiniu-receipt', 'object-read'].includes(String(raw.proof))) throw new DomainError('IMAGE_UPLOAD_REQUIRED', '新账单图片需要已确认的官方上传对象key，普通URL不能代替上传证明'); }
  return unique;
}
