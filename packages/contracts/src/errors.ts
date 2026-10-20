import type { HostError, HostErrorCode } from './generated/types.js';

export class AtlasHostError extends Error {
  readonly code: HostErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(code: HostErrorCode, message: string, options: { retryable?: boolean; details?: Record<string, string | number | boolean | null> } = {}) {
    super(message);
    this.name = 'AtlasHostError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }

  toContract(): HostError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
