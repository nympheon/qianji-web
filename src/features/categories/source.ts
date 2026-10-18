import type { OperationContext } from '../../operations/contract';
import type { ActorScope } from '../../shared/model';
import type { CategoryListInput } from './contract';
import type { CacheKey } from '../../storage/cache';
import { ResourceCache } from '../../storage/cache';
import { assetError } from '../assets/model';
import { flattenCategories } from './model';
import { numericText } from '../../shared/bill-wire';
export const categoryKey = (input: CategoryListInput): CacheKey => ({ domain: 'ledger', queryKey: `category:list:${input.bookId}:${input.type}`, resourceKind: 'category' });
export async function refreshCategories(ctx: Pick<OperationContext, 'repository' | 'client' | 'clock'>, scope: ActorScope, input: CategoryListInput) {
  const cache = new ResourceCache(ctx.repository, ctx.clock), key = categoryKey(input), stamp = cache.captureRead(scope, key), reply = await ctx.client.request('category.list', { uid: scope.uid, bookid: input.bookId, t: input.type }, scope);
  if (!Array.isArray(reply.data) || reply.hasMore) return assetError('CATEGORY_LIST_INCOMPLETE', '分类来源尚未完整返回');
  const raw = flattenCategories(reply.data, input), items = raw.map((raw) => ({ id: numericText(raw.id, ''), kind: 'category' as const, raw }));
  if (cache.applyRead(stamp, { items, complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '分类读取期间发生变化，请重新查看'); return raw;
}
