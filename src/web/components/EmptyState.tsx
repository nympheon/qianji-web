import { InboxIcon } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
export function EmptyState({ title = '暂无账单', description = '试试调整筛选条件，或同步钱迹数据。' }: { title?: string; description?: string }) {
  return <Empty className="min-h-72"><EmptyHeader><EmptyMedia variant="icon"><InboxIcon /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}
