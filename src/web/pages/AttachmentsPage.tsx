import { useState } from 'react';
import { Attachments, AttachmentGallery } from '../components/Attachments';
import { useAction } from '../lib/use-action';
import { DataStatus } from '../components/DataStatus';
import { Button } from '../components/ui/button';
export function AttachmentsPage() {
  const restored = useAction('attachments.draft.get', { key: 'standalone:bill' }), [latest, setLatest] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const reference = latest ?? restored.data?.appliedKey;
  return <div className="page-stack"><section className="content-section"><h2>上传账单图片</h2><p className="muted-copy">在这里上传后，将确认的图片标识交给 ChatGPT，或在记账表单中直接选择图片。上传本身不会新增账单。</p><DataStatus reply={restored.reply} />{restored.reply && !restored.reply.error ? <Attachments references={[]} draftKey="standalone" onChange={(images) => { setLatest(images[0] ?? null); setCopied(false); }} /> : null}</section>{reference ? <section className="content-section"><h2>最近一次确认的图片</h2><AttachmentGallery references={[reference]} /><code className="break-all text-sm">{reference}</code><Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(reference); setCopied(true); }}>{copied ? '已复制图片标识' : '复制图片标识'}</Button><p className="muted-copy">从账单中移除图片引用不会删除云端图片对象。</p></section> : null}</div>;
}
