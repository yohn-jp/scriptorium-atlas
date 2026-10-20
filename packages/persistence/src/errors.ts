import type { HostErrorCode } from '@scriptorium-atlas/contracts';

export type { HostErrorCode };

export class PersistenceError extends Error {
  readonly code: HostErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: HostErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.details = details;
  }
}

export function fail(
  code: HostErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): never {
  throw new PersistenceError(code, message, details);
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

export function asPersistenceError(error: unknown, fallback: HostErrorCode = 'STORAGE_UNAVAILABLE'): PersistenceError {
  if (error instanceof PersistenceError) return error;
  if (isQuotaError(error)) {
    return new PersistenceError('QUOTA_EXCEEDED', 'Browser storage quota was exceeded.');
  }
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'SecurityError' || name === 'NotAllowedError' || name === 'InvalidStateError') {
    return new PersistenceError('STORAGE_UNAVAILABLE', 'IndexedDB is unavailable in this browser context.');
  }
  return new PersistenceError(fallback, error instanceof Error ? error.message : 'IndexedDB operation failed.');
}
