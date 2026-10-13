export type ConnectorErrorKind =
  | 'SOURCE_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'FETCH_ERROR'
  | 'PROCESSING_ERROR'
  | 'RATE_LIMITED'
  | 'CANCELLED';

export interface ConnectorErrorOptions {
  kind: ConnectorErrorKind;
  code: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterSeconds?: number;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, options: ConnectorErrorOptions) {
    super(message, { cause: options.cause });

    this.name = 'ConnectorError';
    this.kind = options.kind;
    this.code = options.code;
    this.retryable = options.retryable;

    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }

    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }

    if (options.metadata !== undefined) {
      this.metadata = options.metadata;
    }
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}
