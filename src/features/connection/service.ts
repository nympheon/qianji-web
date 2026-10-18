import type { ActorScope, Clock } from '../../shared/model';
import type { ProtocolSession } from '../../protocol/signer';
import type { QianjiClient } from '../../protocol/client';
import type { RouteId } from '../../protocol/profile';
import type { Coordinator } from '../../actor/coordinator';
import type { Repository } from '../../storage/database';
import type { CredentialVault } from './vault';
import type { ConnectionView, PasswordLoginInput, RouteCheckView } from './contract';
import { passwordLoginSchema } from './contract';
import { DomainError } from '../../shared/errors';
import { ProtocolError } from '../../protocol/errors';
import { passwordDigest } from '../../protocol/signer';
import { CLIENT_PROFILE, ROUTES } from '../../protocol/profile';
import { parseWire, stringifyWire, wireId, type WireJson } from '../../shared/wire-json';
import type { WireObject } from '../../protocol/signer';
import type { Problem } from '../../shared/reply';
import { isLosslessNumber } from 'lossless-json';

export interface ConnectionDependencies { repository: Repository; client: QianjiClient; coordinator: Coordinator; vault: CredentialVault; clock: Clock }
type ConnectionRow = { uid: string | null; connection_epoch: string | null; token_cipher: string | null;
  credential_generation: number; route: string; state: string; profile_raw: string | null };
interface StoredProfile { user: { id: string; name: string | null; vipType: string | null; vipStartSec: string | null; vipEndSec: string | null } | null; checkedAt: string | null; problem: Problem | null; bootstrap: WireJson }
function object(value: WireJson | undefined): value is WireObject { return value !== null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value); }
function text(value: WireJson | undefined): string | null { return typeof value === 'string' ? value : isLosslessNumber(value) ? value.value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null; }
function profile(row: ConnectionRow): StoredProfile {
  return row.profile_raw ? JSON.parse(row.profile_raw) as StoredProfile : { user: null, checkedAt: null, problem: null, bootstrap: null };
}
function user(value: WireJson | undefined): NonNullable<StoredProfile['user']> {
  if (!object(value)) throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应缺少用户信息', 'protocol', 'unknown');
  let id: string;
  try { id = wireId(value.id ?? null); } catch { throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应缺少用户ID', 'protocol', 'unknown'); }
  return { id, name: typeof value.name === 'string' ? value.name : null, vipType: text(value.viptype), vipStartSec: text(value.vipstart), vipEndSec: text(value.vipend) };
}
function problem(error: unknown): Problem { return error instanceof DomainError ? { code: error.code, message: error.detail } : { code: 'CONNECTION_ERROR', message: '连接操作未能完成' }; }
function checkRoute(route: RouteId): void { if (!Object.hasOwn(ROUTES, route)) throw new DomainError('INVALID_ROUTE', '线路无效'); }

export class ConnectionService {
  constructor(private readonly dependencies: ConnectionDependencies) {}
  private row(): ConnectionRow { return this.dependencies.repository.sql.exec<ConnectionRow>('SELECT uid,connection_epoch,token_cipher,credential_generation,route,state,profile_raw FROM connection WHERE singleton=1').one(); }
  private cancelSources(where: string, bindings: string[], reason: Problem): void {
    const { repository, clock } = this.dependencies;
    repository.sql.exec(`UPDATE sync_jobs SET state='failed',error=?,finished_ms=? WHERE state='running' AND (${where})`, JSON.stringify(reason), clock.nowMs(), ...bindings).toArray();
    repository.sql.exec(`UPDATE rebuild_jobs SET state='failed',error=? WHERE state='running' AND (${where})`, JSON.stringify(reason), ...bindings).toArray();
    repository.sql.exec(`DELETE FROM sync_barrier WHERE ${where}`, ...bindings).toArray();
    repository.sql.exec(`DELETE FROM jobs WHERE ${where}`, ...bindings).toArray();
  }
  private invalidateReads(uid: string): void {
    const { repository } = this.dependencies;
    repository.sql.exec('UPDATE source_domains SET generation=generation+1 WHERE uid=?', uid).toArray();
    repository.sql.exec('INSERT OR IGNORE INTO source_domains(uid,domain,generation) SELECT uid,domain,1 FROM datasets WHERE uid=? GROUP BY uid,domain', uid).toArray();
    repository.sql.exec('UPDATE source_queries SET invalidated=1 WHERE uid=?', uid).toArray();
  }
  view(): ConnectionView {
    const row = this.row(), saved = profile(row);
    return { state: row.state as ConnectionView['state'], uid: row.uid, connectionEpoch: row.connection_epoch, route: row.route as RouteId,
      user: saved.user ? { name: saved.user.name, vipType: saved.user.vipType, vipEndSec: saved.user.vipEndSec } : null,
      lastCheckedAt: saved.checkedAt, problem: saved.problem, refreshAvailable: false, protocolVersion: '4.5.4' };
  }
  scope(): ActorScope | null { const row = this.row(); return row.uid !== null && row.connection_epoch !== null ? { uid: row.uid, connectionEpoch: row.connection_epoch } : null; }
  async session(scope: ActorScope): Promise<ProtocolSession | null> {
    const { repository, vault } = this.dependencies;
    repository.assertScope(scope);
    const row = this.row();
    if (row.state !== 'connected' || row.token_cipher === null) return null;
    const token = await vault.decrypt(row.token_cipher, scope);
    repository.assertScope(scope);
    if (this.row().credential_generation !== row.credential_generation) throw new ProtocolError('QIANJI_SCOPE_MISMATCH', '凭证已更新，请使用当前连接', 'session', 'not-sent');
    return { scope, utoken: token, credentialGeneration: row.credential_generation };
  }
  async login(input: PasswordLoginInput): Promise<ConnectionView> {
    const parsed = passwordLoginSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_LOGIN_INPUT', '请输入有效的手机号或邮箱和密码');
    const { vault, coordinator, client, repository, clock } = this.dependencies;
    await vault.ready();
    return coordinator.changeConnection(async () => {
      const reply = await client.request('account.login', { v: parsed.data.account, pwd: passwordDigest(parsed.data.password) }, null);
      if (!object(reply.data) || typeof reply.data.token !== 'string' || reply.data.token.length === 0) throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应缺少登录凭证', 'protocol', 'unknown');
      const account = user(reply.data.user), previous = this.row();
      const scope = { uid: account.id, connectionEpoch: previous.uid === account.id && previous.connection_epoch ? previous.connection_epoch : crypto.randomUUID() };
      const cipher = await vault.encrypt(reply.data.token, scope);
      const saved: StoredProfile = { user: account, checkedAt: clock.nowIso(), problem: null, bootstrap: { books: reply.data.books ?? [] } };
      repository.transaction(() => {
        repository.sql.exec("UPDATE connection SET uid=?,connection_epoch=?,token_cipher=?,credential_generation=credential_generation+1,state='connected',profile_raw=? WHERE singleton=1", scope.uid, scope.connectionEpoch, cipher, JSON.stringify({ ...saved, bootstrap: null })).toArray();
        // Store only the business bootstrap, never the complete login envelope/token.
        repository.sql.exec('INSERT INTO instance_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `bootstrap:${scope.uid}`, stringifyWire(saved.bootstrap)).toArray();
        this.cancelSources('uid<>? OR connection_epoch<>?', [scope.uid, scope.connectionEpoch], { code: 'CONNECTION_CHANGED', message: '账号连接已变更，原同步任务已停止' });
      });
      await coordinator.recover();
      return this.view();
    });
  }
  bootstrap(scope: ActorScope): WireJson {
    this.dependencies.repository.assertScope(scope);
    const row = this.dependencies.repository.sql.exec<{ value: string }>('SELECT value FROM instance_meta WHERE key=?', `bootstrap:${scope.uid}`).toArray()[0];
    return row ? parseWire(row.value) : null;
  }
  private initParams(scope: ActorScope): WireObject {
    const current = profile(this.row()).user;
    let vip = false;
    if (current?.vipType && current.vipStartSec && current.vipEndSec && /^\d+$/.test(current.vipType) && /^\d+$/.test(current.vipStartSec) && /^\d+$/.test(current.vipEndSec)) {
      const now = BigInt(Math.floor(this.dependencies.clock.nowMs() / 1000));
      vip = BigInt(current.vipType) >= 1n && now >= BigInt(current.vipStartSec) && now < BigInt(current.vipEndSec);
    }
    return { uid: scope.uid, v: String(CLIENT_PROFILE.versionCode), vvmark: vip ? '1' : '0', newinstall: '0', upgradealert: '0' };
  }
  async check(): Promise<ConnectionView> {
    const row = this.row(), scope = this.scope();
    if (!scope || row.state !== 'connected') return this.view();
    try {
      const reply = await this.dependencies.client.request('client.init', this.initParams(scope), scope);
      if (!object(reply.data)) throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应缺少配置', 'protocol', 'unknown');
      const account = user(reply.data.userinfo);
      if (account.id !== scope.uid) throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹返回的账号不匹配', 'protocol', 'unknown');
      const saved: StoredProfile = { user: account, checkedAt: this.dependencies.clock.nowIso(), problem: null, bootstrap: null };
      this.dependencies.repository.sql.exec('UPDATE connection SET profile_raw=? WHERE singleton=1 AND uid=? AND connection_epoch=? AND credential_generation=?', JSON.stringify(saved), scope.uid, scope.connectionEpoch, row.credential_generation).toArray();
    } catch (error) {
      const current = this.row();
      if (current.uid === scope.uid && current.connection_epoch === scope.connectionEpoch && current.credential_generation === row.credential_generation) {
        const saved = profile(current); saved.problem = problem(error);
        this.dependencies.repository.sql.exec('UPDATE connection SET profile_raw=? WHERE singleton=1', JSON.stringify(saved)).toArray();
      }
    }
    return this.view();
  }
  async refresh(): Promise<ConnectionView> { throw new DomainError('REFRESH_UNVERIFIED', '令牌刷新尚未真实验证，请使用重新登录'); }
  async logout(): Promise<ConnectionView> {
    return this.dependencies.coordinator.changeConnection(async () => {
      const scope = this.scope(), row = this.row();
      let warning: Problem | null = null;
      if (scope && row.state === 'connected') {
        try { await this.dependencies.client.request('account.logout', { uid: scope.uid }, scope); }
        catch { warning = { code: 'LOGOUT_REMOTE_UNCONFIRMED', message: '本服务已退出，钱迹远端退出结果未确认' }; }
      }
      const saved = profile(this.row()); saved.problem = warning;
      this.dependencies.repository.transaction(() => {
        this.dependencies.repository.sql.exec("UPDATE connection SET token_cipher=NULL,credential_generation=credential_generation+1,state='disconnected',profile_raw=? WHERE singleton=1", JSON.stringify(saved)).toArray();
        this.cancelSources('1=1', [], { code: 'CONNECTION_CLOSED', message: '已退出钱迹，原同步任务已停止' });
        if (scope) this.invalidateReads(scope.uid);
      });
      await this.dependencies.coordinator.jobs.refreshAlarm();
      return this.view();
    });
  }
  async selectRoute(route: RouteId): Promise<ConnectionView> {
    checkRoute(route);
    return this.dependencies.coordinator.changeConnection(async () => {
      this.dependencies.repository.sql.exec('UPDATE connection SET route=? WHERE singleton=1', route).toArray();
      return this.view();
    });
  }
  async testRoute(route: RouteId): Promise<RouteCheckView> {
    checkRoute(route);
    const scope = this.scope(), started = this.dependencies.clock.nowMs();
    if (!scope || this.view().state !== 'connected') return { route, status: 'unavailable', latencyMs: null, error: { code: 'CONNECTION_REQUIRED', message: '登录后可检测钱迹线路' } };
    try {
      const reply = await this.dependencies.client.withRoute(route).request('client.init', this.initParams(scope), scope);
      if (!object(reply.data) || user(reply.data.userinfo).id !== scope.uid) throw new ProtocolError('QIANJI_RESPONSE_INVALID', '线路未返回当前账号信息', 'protocol', 'unknown');
      return { route, status: 'ok', latencyMs: Math.max(0, this.dependencies.clock.nowMs() - started), error: null };
    } catch (error) { return { route, status: 'error', latencyMs: Math.max(0, this.dependencies.clock.nowMs() - started), error: problem(error) }; }
  }
  expire(scope: ActorScope, generation: number | undefined): void {
    if (generation === undefined) return;
    const row = this.row();
    if (row.uid !== scope.uid || row.connection_epoch !== scope.connectionEpoch || row.credential_generation !== generation) return;
    const saved = profile(row); saved.problem = { code: 'QIANJI_SESSION_EXPIRED', message: '钱迹连接需要重新登录' };
    this.dependencies.repository.transaction(() => {
      this.dependencies.repository.sql.exec("UPDATE connection SET token_cipher=NULL,state='needs_login',credential_generation=credential_generation+1,profile_raw=? WHERE singleton=1 AND uid=? AND connection_epoch=? AND credential_generation=?", JSON.stringify(saved), scope.uid, scope.connectionEpoch, generation).toArray();
      this.cancelSources('uid=? AND connection_epoch=?', [scope.uid, scope.connectionEpoch], saved.problem!);
      this.invalidateReads(scope.uid);
    });
  }
}
