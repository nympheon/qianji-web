import { isLosslessNumber } from 'lossless-json';
import type { ActorScope, Clock } from '../shared/model';
import { parseWire } from '../shared/wire-json';
import type { WireJson } from '../shared/wire-json';
import { ProtocolError } from './errors';
import { operationDefinition } from './operations';
import type { ProtocolOperation } from './operations';
import { CLIENT_PROFILE } from './profile';
import type { ClientProfile, RouteId } from './profile';
import { signRequest } from './signer';
import type { ProtocolSession, WireObject } from './signer';

export interface ProtocolReply { ec: string; data: WireJson; httpStatus: number }
export interface ClientOptions {
  clock: Clock;
  deviceId(): string;
  route(): RouteId;
  session(scope: ActorScope): Promise<ProtocolSession | null>;
  profile?: Readonly<ClientProfile>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readOnly?: boolean;
}

function object(value: WireJson | undefined): value is WireObject {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value);
}

function code(value: WireJson | undefined): string | undefined {
  const text = typeof value === 'string' ? value : isLosslessNumber(value) ? value.value : undefined;
  return text !== undefined && /^-?\d+$/.test(text) ? text : undefined;
}

export class QianjiClient {
  constructor(private readonly options: ClientOptions) {}

  asReadOnly(): QianjiClient { return new QianjiClient({ ...this.options, readOnly: true }); }

  async request(op: ProtocolOperation, params: WireObject, scope: ActorScope | null): Promise<ProtocolReply> {
    const operation = operationDefinition(op);
    if (this.options.readOnly && !operation.readOnly) {
      throw new ProtocolError('READ_ONLY_PROTOCOL', '结果核查只允许已确认的读取接口', 'protocol', 'not-sent');
    }
    const session = scope === null ? null : await this.options.session(scope);
    if (scope && (!session || session.scope.uid !== scope.uid || session.scope.connectionEpoch !== scope.connectionEpoch)) {
      throw new ProtocolError('QIANJI_SCOPE_MISMATCH', '请求不属于当前钱迹连接', 'session', 'not-sent');
    }
    const signed = await signRequest({ op, params, profile: this.options.profile ?? CLIENT_PROFILE,
      nowMs: this.options.clock.nowMs(), deviceId: this.options.deviceId(), route: this.options.route(),
      ...(session ? { session } : {}),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), operation.timeoutMs);
    try {
      const response = await (this.options.fetch ?? fetch)(signed.url, {
        method: signed.method, headers: signed.headers, body: signed.body,
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProtocolError('QIANJI_HTTP_ERROR', '钱迹返回HTTP错误', 'http', 'unknown', { httpStatus: response.status });
      }
      const text = await response.text();
      let envelope: WireJson;
      try { envelope = parseWire(text); } catch {
        throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应格式发生变化', 'protocol', 'unknown');
      }
      const ec = object(envelope) ? code(envelope.ec) : undefined;
      if (!object(envelope) || ec === undefined) {
        throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应格式发生变化', 'protocol', 'unknown');
      }
      if (ec !== '200') {
        let detail = envelope.em;
        if (typeof detail === 'string') {
          try { detail = parseWire(detail); } catch { detail = undefined; }
        }
        const subcode = object(detail) ? code(detail.code) : undefined;
        if (ec === '8888' && subcode === '40005') {
          throw new ProtocolError('QIANJI_SESSION_EXPIRED', '钱迹连接需要重新登录', 'session', 'rejected', { upstreamCode: ec, upstreamSubcode: subcode });
        }
        if (ec === '8888' && subcode === '40009') {
          throw new ProtocolError('QIANJI_RESTRICTED', '钱迹限制当前操作', 'business', 'rejected', { upstreamCode: ec, upstreamSubcode: subcode });
        }
        throw new ProtocolError('QIANJI_BUSINESS_ERROR', '钱迹业务请求未成功，需按回执核查', 'business', 'unknown',
          { upstreamCode: ec, ...(subcode !== undefined ? { upstreamSubcode: subcode } : {}) });
      }
      const data = envelope.data ?? null;
      if (operation.response === 'object' && !object(data)) {
        throw new ProtocolError('QIANJI_RESPONSE_INVALID', '钱迹响应缺少预期数据', 'protocol', 'unknown', { upstreamCode: ec });
      }
      return { ec, data, httpStatus: response.status };
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (controller.signal.aborted) throw new ProtocolError('QIANJI_TIMEOUT', '钱迹请求超时，结果可能需要核查', 'timeout', 'unknown');
      throw new ProtocolError('QIANJI_NETWORK_ERROR', '无法连接钱迹服务', 'network', 'unknown');
    } finally {
      clearTimeout(timeout);
    }
  }
}
