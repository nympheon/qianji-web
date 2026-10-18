import type { Repository } from '../../storage/database';
import type { ActorScope, Clock } from '../../shared/model';
import { asBillObject, numericText } from '../../shared/bill-wire';
import { parseWire, stringifyWire, type WireJson } from '../../shared/wire-json';
export interface ImageConfig { maxBillImages: number; billHost: string; publicHost: string; source: 'apk-default' | 'qianji'; validatedAt: number | null; stale: boolean }
export class ImageConfiguration {
  constructor(private readonly dependencies: { repository: Repository; clock: Clock }) {}
  applyOfficial(scope: ActorScope, value: WireJson | undefined) {
    if (value == null) return; const raw = asBillObject(value), config = Object.fromEntries(['max_bill_image', 'bill_image_host', 'pub_image_host'].filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]!])); this.dependencies.repository.assertScope(scope);
    this.dependencies.repository.sql.exec('INSERT INTO media_config(uid,config_json,validated_ms) VALUES (?,?,?) ON CONFLICT(uid) DO UPDATE SET config_json=excluded.config_json,validated_ms=excluded.validated_ms', scope.uid, stringifyWire({ ...this.previous(scope), ...config }), this.dependencies.clock.nowMs()).toArray();
  }
  private previous(scope: ActorScope) { const row = this.dependencies.repository.sql.exec<{ config_json: string }>('SELECT config_json FROM media_config WHERE uid=?', scope.uid).toArray()[0]; return row ? asBillObject(parseWire(row.config_json)) : {}; }
  read(scope: ActorScope): ImageConfig {
    this.dependencies.repository.assertScope(scope); const row = this.dependencies.repository.sql.exec<{ config_json: string; validated_ms: number }>('SELECT config_json,validated_ms FROM media_config WHERE uid=?', scope.uid).toArray()[0], raw = row ? asBillObject(parseWire(row.config_json)) : {}, maximum = Number(numericText(raw.max_bill_image, '')), valid = Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 200;
    const host = (value: WireJson | undefined, fallback: string) => { if (typeof value !== 'string') return fallback; try { const url = new URL(value); if (url.protocol === 'http:' && url.hostname === 'billimg.qianjiapp.com') url.protocol = 'https:'; if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fallback; return url.href.endsWith('/') ? url.href : `${url.href}/`; } catch { return fallback; } };
    return { maxBillImages: valid ? maximum : 6, billHost: host(raw.bill_image_host, 'https://billimg.qianjiapp.com/'), publicHost: host(raw.pub_image_host, 'http://img.qianjiapp.com/'), source: valid ? 'qianji' : 'apk-default', validatedAt: row?.validated_ms ?? null, stale: !row || this.dependencies.clock.nowMs() - row.validated_ms >= 60_000 };
  }
}
