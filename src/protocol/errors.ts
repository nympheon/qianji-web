import { DomainError } from '../shared/errors';

export type OutcomeCertainty = 'not-sent' | 'rejected' | 'unknown';
export type ProtocolErrorKind = 'session' | 'network' | 'timeout' | 'http' | 'protocol' | 'business';
interface ErrorInfo { upstreamCode?: string; upstreamSubcode?: string; httpStatus?: number }

export class ProtocolError extends DomainError {
  readonly upstreamCode: string | undefined;
  readonly upstreamSubcode: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(code: string, message: string, readonly kind: ProtocolErrorKind,
    readonly certainty: OutcomeCertainty, info: ErrorInfo = {}) {
    super(code, message);
    this.upstreamCode = info.upstreamCode;
    this.upstreamSubcode = info.upstreamSubcode;
    this.httpStatus = info.httpStatus;
  }
}
