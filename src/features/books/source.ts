import type { ActorScope, Clock } from '../../shared/model';
import type { Repository } from '../../storage/database';
import type { QianjiClient } from '../../protocol/client';
import { ResourceCache, type CacheKey } from '../../storage/cache';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { assetError } from '../assets/model';
import { validateBook } from './model';
export const bookListKey: CacheKey = { domain: 'books', queryKey: 'book:list:-1', resourceKind: 'book' };
export async function refreshBooks(ctx: { repository: Repository; client: QianjiClient; clock: Clock }, scope: ActorScope) {
  const cache = new ResourceCache(ctx.repository, ctx.clock), stamp = cache.captureRead(scope, bookListKey), reply = await ctx.client.request('book.list', { uid: scope.uid, t: -1 }, scope);
  if (!Array.isArray(reply.data) || reply.hasMore || reply.data.length > 5000) return assetError('BOOK_LIST_INVALID', '账本列表未完整返回或结构无法核对');
  const items = reply.data.map((value) => { const raw = validateBook(asBillObject(value)); return { id: numericText(raw.bookid, ''), kind: 'book' as const, raw }; });
  if (new Set(items.map((item) => item.id)).size !== items.length) return assetError('BOOK_LIST_INVALID', '账本列表包含重复ID');
  if (cache.applyRead(stamp, { items, complete: true }) !== 'applied') return assetError('SOURCE_SUPERSEDED', '账本读取期间发生变化，请重新查看'); return items;
}
