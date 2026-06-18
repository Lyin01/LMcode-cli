import type { LmcodeErrorCode } from './codes';

export interface LmcodeErrorOptions {
  /** JSON-serializable structured details. */
  readonly details?: Record<string, unknown>;
  /** Original error or value. Local-only; never serialized to the wire. */
  readonly cause?: unknown;
}

/**
 * The single Scream error class.
 *
 * Discrimination is always by `code`. Cross-process consumers receive
 * `LmcodeErrorPayload` and must branch on `code` rather than class identity.
 */
export class LmcodeError extends Error {
  readonly code: LmcodeErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: LmcodeErrorCode, message: string, options: LmcodeErrorOptions = {}) {
    super(message);
    this.name = 'LmcodeError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}
