import { createHash } from 'node:crypto';
import { isLosslessNumber } from 'lossless-json';
import type { ActorScope } from '../shared/model';
import { stringifyWire, wireId } from '../shared/wire-json';
import type { WireJson } from '../shared/wire-json';
import { ProtocolError } from './errors';
import { operationDefinition } from './operations';
import type { ProtocolOperation } from './operations';
import { ROUTES } from './profile';
import type { ClientProfile, RouteId } from './profile';

export type WireObject = { [key: string]: WireJson | undefined };
export interface ProtocolSession { scope: ActorScope; utoken: string; credentialGeneration?: number }
export interface SigningInput {
  op: ProtocolOperation;
  params: WireObject;
  profile: Readonly<ClientProfile>;
  nowMs: number;
  deviceId: string;
  route: RouteId;
  session?: ProtocolSession;
}
export interface SignedRequest { url: string; method: 'POST'; headers: Record<string, string>; body: string }

function md5(text: string): string { return createHash('md5').update(text, 'utf8').digest('hex'); }

export function createReqidv2(input: { packageName: string; versionCode: number; nowMs: number; ctrl: string; act: string }): string {
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.versionCode)) {
    throw new ProtocolError('INVALID_SIGNING_INPUT', '签名时间或版本无效', 'protocol', 'not-sent');
  }
  const time = BigInt(input.nowMs) + BigInt(input.versionCode) + 9_081_127n;
  return md5(input.packageName + time.toString() + input.ctrl + input.act + 'free20170908&x_*1127');
}

export function encodeReqid(reqid: string): string { return md5(reqid + 'michaeljackson'); }
export function createTok(reqid: string, ctrl: string, act: string): string { return md5(reqid + '1172020' + ctrl + encodeReqid(reqid) + act); }
export function passwordDigest(password: string): string { return password === '' ? '' : md5(password); }

function formValue(value: WireJson): string {
  if (typeof value === 'string') return value;
  if (isLosslessNumber(value)) return value.value;
  return stringifyWire(value);
}

export async function signRequest(input: SigningInput): Promise<SignedRequest> {
  const operation = operationDefinition(input.op);
  const { session, profile } = input;
  if (!Object.hasOwn(ROUTES, input.route)) {
    throw new ProtocolError('INVALID_ROUTE', '线路无效', 'protocol', 'not-sent');
  }
  if (operation.requiresSession && !session) {
    throw new ProtocolError('QIANJI_NOT_CONNECTED', '请先连接钱迹账号', 'session', 'not-sent');
  }
  if (session && input.params.uid != null && wireId(input.params.uid) !== session.scope.uid) {
    throw new ProtocolError('QIANJI_SCOPE_MISMATCH', '请求不属于当前钱迹账号', 'session', 'not-sent');
  }
  const reqid = createReqidv2({ packageName: profile.packageName, versionCode: profile.versionCode,
    nowMs: input.nowMs, ctrl: operation.ctrl, act: operation.act });
  const headers: Record<string, string> = {
    ctrl: operation.ctrl, act: operation.act, reqidv2: reqid, tok: createTok(reqid, operation.ctrl, operation.act),
    mk: profile.market, os: '1', osvs: profile.osVersion, devbrand: profile.brand, devname: profile.deviceName,
    devid: input.deviceId, pkg: profile.packageName, vs: String(profile.versionCode), vsn: profile.versionName,
    clang: profile.language, cregion: profile.region, timezoneoffset: profile.timezoneOffsetSeconds,
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
  if (session) headers.utoken = session.utoken;
  if (operation.constructor === 'sync-string') headers.htoken = '1';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.params)) {
    if (value !== undefined && value !== null) params.set(key, formValue(value));
  }
  if (session) params.set('fr', session.scope.uid);
  return { url: `${ROUTES[input.route]}/${operation.ctrl}/${operation.act}`, method: 'POST', headers, body: params.toString() };
}
