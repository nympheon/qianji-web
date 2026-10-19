import { useState } from 'react';
import { CreditCardIcon, WalletIcon } from 'lucide-react';
import type { AssetView } from '../../features/assets/contract';
import { cn } from '../lib/utils';

export function AssetIcon({ asset }: { asset: AssetView }) {
  const [failed, setFailed] = useState<string | null>(null);
  const reference = asset.icon, artwork = !!reference && reference !== failed;
  const color = artwork && /^#?(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(asset.color ?? '') ? `#${asset.color!.replace(/^#/, '')}` : undefined;
  const bankCard = asset.type === 1 && asset.subtype === 12 || asset.type === 2 && [21, 200].includes(asset.subtype);
  const Icon = asset.type === 2 || asset.type === 1 && asset.subtype === 12 ? CreditCardIcon : WalletIcon;
  return <span className={cn('asset-symbol', artwork && 'asset-artwork')} style={color ? bankCard ? { borderColor: color } : { backgroundColor: color } : undefined}>
    {artwork ? <img src={'/api/images?' + new URLSearchParams({ reference, purpose: 'asset', size: 'small' })} alt={`${asset.name} 图标`} width={32} height={32} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(reference)} /> : <Icon aria-hidden="true" />}
  </span>;
}
