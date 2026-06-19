/**
 * Base error for all chat provider errors.
 */
export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatProviderError';
  }
}

/**
 * Network-level connection failure.
 */
export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIConnectionError';
  }
}

/**
 * Request timed out.
 */
export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APITimeoutError';
  }
}

/**
 * HTTP status error from the API.
 */
export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;
  /**
   * Server-suggested delay before retrying, in milliseconds, parsed from
   * response headers (`Retry-After`, `retry-after-ms`, etc.). Undefined when
   * the server gave no hint or it could not be parsed.
   */
  readonly retryAfterMs?: number;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * HTTP status error that specifically means the request exceeded the model
 * context window.
 */
export class APIContextOverflowError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number,
  ) {
    super(statusCode, message, requestId, retryAfterMs);
    this.name = 'APIContextOverflowError';
  }
}

/**
 * HTTP status error that specifically means the provider rate-limited the
 * request.
 */
export class APIProviderRateLimitError extends APIStatusError {
  constructor(message: string, requestId?: string | null, retryAfterMs?: number) {
    super(429, message, requestId, retryAfterMs);
    this.name = 'APIProviderRateLimitError';
  }
}

/**
 * The API returned an empty response (no content, no tool calls).
 */
export class APIEmptyResponseError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIEmptyResponseError';
  }
}

export function isRetryableGenerateError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  return error instanceof APIStatusError && [429, 500, 502, 503, 504].includes(error.statusCode);
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
] as const;

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

const PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS = [
  /(?:apistatuserror.*429|429.*apistatuserror)/,
  /429.*too many requests/,
  /too many requests/,
  /provider\.rate_limit/,
  /reached .*max rpm/,
  /rate[ _-]?limit(?:ed)?/,
  /rate-limited/,
] as const;

export interface NormalizeAPIStatusErrorOptions {
  /** Server-suggested retry delay in milliseconds, parsed from response headers. */
  readonly retryAfterMs?: number;
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
  options?: NormalizeAPIStatusErrorOptions,
): APIStatusError {
  const retryAfterMs = options?.retryAfterMs;
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, retryAfterMs);
  }
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(statusCode, message, requestId, retryAfterMs);
  }
  return new APIStatusError(statusCode, message, requestId, retryAfterMs);
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderRateLimitError(error: unknown): boolean {
  if (error instanceof APIProviderRateLimitError) return true;

  const statusCode = getStatusCode(error);
  if (statusCode !== undefined) return statusCode === 429;

  const lowerMessage = errorMessage(error).toLowerCase();
  return PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const record = error as Record<string, unknown>;
  const statusCode = record['statusCode'];
  if (typeof statusCode === 'number') return statusCode;
  const status = record['status'];
  if (typeof status === 'number') return status;

  const response = record['response'];
  if (typeof response !== 'object' || response === null) return undefined;
  const responseRecord = response as Record<string, unknown>;
  const responseStatusCode = responseRecord['statusCode'];
  if (typeof responseStatusCode === 'number') return responseStatusCode;
  const responseStatus = responseRecord['status'];
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A header source: either a `Headers` instance, a plain getter, or a record of
 * header values. Header names are matched case-insensitively.
 */
export type HeaderSource =
  | Headers
  | ((name: string) => string | null | undefined)
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function headerGetter(headers: HeaderSource): (name: string) => string | undefined {
  if (headers === null || headers === undefined) {
    return () => undefined;
  }
  if (typeof headers === 'function') {
    return (name) => {
      const value = headers(name);
      return value === null || value === undefined ? undefined : value;
    };
  }
  if (typeof (headers as Headers).get === 'function') {
    return (name) => (headers as Headers).get(name) ?? undefined;
  }
  // Plain object: build a lower-cased lookup once.
  const record = headers as Record<string, string | string[] | undefined>;
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    lowered.set(key.toLowerCase(), Array.isArray(value) ? (value[0] ?? '') : value);
  }
  return (name) => lowered.get(name.toLowerCase());
}

/**
 * Parse a server-provided retry hint into milliseconds, being defensive about
 * missing or malformed values.
 *
 * Precedence:
 *  1. `retry-after-ms` — integer milliseconds (some providers / OpenAI).
 *  2. `Retry-After` — either an integer number of seconds, or an HTTP-date.
 *
 * Returns `undefined` when no usable hint is present.
 */
export function parseRetryAfterMs(headers: HeaderSource): number | undefined {
  const get = headerGetter(headers);

  const retryAfterMs = parseRetryAfterMsHeader(get('retry-after-ms'));
  if (retryAfterMs !== undefined) return retryAfterMs;

  return parseRetryAfterHeader(get('retry-after'));
}

function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  // Integer milliseconds. Reject non-numeric / fractional / negative values.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const ms = Number(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // Integer number of seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  // HTTP-date: compute the delta from now, floored at 0.
  const target = Date.parse(trimmed);
  if (Number.isNaN(target)) return undefined;
  return Math.max(0, target - Date.now());
}
