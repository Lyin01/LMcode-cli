import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isProviderRateLimitError,
  isRetryableGenerateError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
} from '#/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ChatProviderError', () => {
  it('is an instance of Error', () => {
    const err = new ChatProviderError('base error');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.message).toBe('base error');
    expect(err.name).toBe('ChatProviderError');
  });
});

describe('APIConnectionError', () => {
  it('extends ChatProviderError', () => {
    const err = new APIConnectionError('connection refused');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIConnectionError');
    expect(err.message).toBe('connection refused');
  });
});

describe('APITimeoutError', () => {
  it('extends ChatProviderError', () => {
    const err = new APITimeoutError('request timed out after 30s');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APITimeoutError');
    expect(err.message).toBe('request timed out after 30s');
  });
});

describe('APIStatusError', () => {
  it('extends ChatProviderError and stores status code', () => {
    const err = new APIStatusError(429, 'rate limited', 'req-abc');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIStatusError');
    expect(err.message).toBe('rate limited');
    expect(err.statusCode).toBe(429);
    expect(err.requestId).toBe('req-abc');
  });

  it('accepts null requestId', () => {
    const err = new APIStatusError(500, 'server error', null);
    expect(err.statusCode).toBe(500);
    expect(err.requestId).toBeNull();
  });

  it('defaults requestId to null when omitted', () => {
    const err = new APIStatusError(502, 'bad gateway');
    expect(err.statusCode).toBe(502);
    expect(err.requestId).toBeNull();
  });
});

describe('APIEmptyResponseError', () => {
  it('extends ChatProviderError', () => {
    const err = new APIEmptyResponseError('empty response');
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIEmptyResponseError');
    expect(err.message).toBe('empty response');
  });
});

describe('APIContextOverflowError', () => {
  it('extends APIStatusError and preserves HTTP details', () => {
    const err = new APIContextOverflowError(400, 'Context length exceeded', 'req-context');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIContextOverflowError');
    expect(err.statusCode).toBe(400);
    expect(err.requestId).toBe('req-context');
  });
});

describe('APIProviderRateLimitError', () => {
  it('extends APIStatusError with status 429', () => {
    const err = new APIProviderRateLimitError('too many requests', 'req-429');
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect(err.name).toBe('APIProviderRateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.requestId).toBe('req-429');
  });

  it('defaults requestId to null when omitted', () => {
    const err = new APIProviderRateLimitError('rate limited');
    expect(err.requestId).toBeNull();
  });
});

describe('isRetryableGenerateError', () => {
  it('matches transient provider errors and empty generate responses', () => {
    expect(isRetryableGenerateError(new APIConnectionError('conn'))).toBe(true);
    expect(isRetryableGenerateError(new APITimeoutError('timeout'))).toBe(true);
    expect(isRetryableGenerateError(new APIEmptyResponseError('empty'))).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])('treats HTTP %i as retryable', (statusCode) => {
    expect(isRetryableGenerateError(new APIStatusError(statusCode, 'retryable'))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats HTTP %i as non-retryable', (statusCode) => {
    expect(isRetryableGenerateError(new APIStatusError(statusCode, 'non-retryable'))).toBe(false);
  });

  it('does not retry context overflow or unknown errors', () => {
    expect(
      isRetryableGenerateError(new APIContextOverflowError(400, 'Context length exceeded')),
    ).toBe(false);
    expect(isRetryableGenerateError(new Error('boom'))).toBe(false);
    expect(isRetryableGenerateError('boom')).toBe(false);
  });
});

describe('error hierarchy instanceof checks', () => {
  it('all error types are instanceof ChatProviderError', () => {
    const errors = [
      new APIConnectionError('conn'),
      new APITimeoutError('timeout'),
      new APIStatusError(400, 'status', null),
      new APIContextOverflowError(400, 'context length exceeded'),
      new APIProviderRateLimitError('rate limited'),
      new APIEmptyResponseError('empty'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(ChatProviderError);
    }
  });

  it('specific types are distinguishable', () => {
    const connErr = new APIConnectionError('conn');
    const statusErr = new APIStatusError(400, 'status', null);

    expect(connErr).not.toBeInstanceOf(APIStatusError);
    expect(statusErr).not.toBeInstanceOf(APIConnectionError);
  });

  it('can catch with ChatProviderError and inspect subtype', () => {
    const err: ChatProviderError = new APIStatusError(404, 'not found', 'req-123');

    if (err instanceof APIStatusError) {
      expect(err.statusCode).toBe(404);
      expect(err.requestId).toBe('req-123');
    } else {
      expect.unreachable('Expected APIStatusError');
    }
  });
});

describe('normalizeAPIStatusError', () => {
  it.each([
    [400, 'Context length exceeded'],
    [400, 'Exceeded max tokens'],
    [413, 'Context length exceeded'],
    [422, 'Maximum context window exceeded'],
    [400, 'context_length_exceeded'],
    [422, 'Too many tokens in prompt'],
    [400, 'prompt is too long: 210000 tokens exceeds the maximum'],
    [400, 'input token count 131072 exceeds the maximum number of tokens allowed'],
    [400, 'Invalid request: Your request exceeded model token limit: 262144 (requested: 274613)'],
  ])('normalizes %i "%s" to APIContextOverflowError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message, 'req-context');
    expect(error).toBeInstanceOf(APIContextOverflowError);
    expect(error.statusCode).toBe(statusCode);
    expect(error.requestId).toBe('req-context');
  });

  it.each([
    [401, 'Context length exceeded'],
    [500, 'Context length exceeded'],
    [400, 'Bad request'],
    [422, 'Invalid tool schema'],
    [400, 'max_tokens must be less than or equal to 4096'],
    [422, 'max_output_tokens must not exceed 8192'],
    [400, 'max tokens must not exceed the configured output limit'],
  ])('keeps %i "%s" as APIStatusError', (statusCode, message) => {
    const error = normalizeAPIStatusError(statusCode, message);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).not.toBeInstanceOf(APIContextOverflowError);
  });

  it('normalizes 429 to APIProviderRateLimitError', () => {
    const error = normalizeAPIStatusError(429, 'Too Many Requests', 'req-rate');
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.statusCode).toBe(429);
    expect(error.requestId).toBe('req-rate');
  });
});

describe('isProviderRateLimitError', () => {
  it('matches APIProviderRateLimitError instances', () => {
    expect(isProviderRateLimitError(new APIProviderRateLimitError('rate limited'))).toBe(true);
  });

  it('matches APIStatusError with statusCode 429', () => {
    expect(isProviderRateLimitError(new APIStatusError(429, 'too many requests'))).toBe(true);
  });

  it('matches errors with rate limit message patterns', () => {
    expect(isProviderRateLimitError(new Error('rate-limited by provider'))).toBe(true);
    expect(isProviderRateLimitError(new Error('too many requests'))).toBe(true);
    expect(isProviderRateLimitError(new Error('reached max rpm'))).toBe(true);
  });

  it('does not match non-rate-limit errors', () => {
    expect(isProviderRateLimitError(new APIStatusError(500, 'server error'))).toBe(false);
    expect(isProviderRateLimitError(new APIConnectionError('connection refused'))).toBe(false);
    expect(isProviderRateLimitError(new Error('something else'))).toBe(false);
  });
});

describe('retryAfterMs on status errors', () => {
  it('APIStatusError stores retryAfterMs when provided', () => {
    const err = new APIStatusError(503, 'unavailable', 'req-1', 2000);
    expect(err.retryAfterMs).toBe(2000);
  });

  it('APIStatusError leaves retryAfterMs undefined when omitted (backward-compatible)', () => {
    const err = new APIStatusError(500, 'server error');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('APIProviderRateLimitError carries retryAfterMs', () => {
    const err = new APIProviderRateLimitError('rate limited', 'req-2', 5000);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('APIContextOverflowError carries retryAfterMs', () => {
    const err = new APIContextOverflowError(400, 'too long', 'req-3', 1000);
    expect(err.retryAfterMs).toBe(1000);
  });

  it('normalizeAPIStatusError propagates retryAfterMs to a rate-limit error', () => {
    const err = normalizeAPIStatusError(429, 'Too Many Requests', 'req-rate', {
      retryAfterMs: 12_000,
    });
    expect(err).toBeInstanceOf(APIProviderRateLimitError);
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('normalizeAPIStatusError propagates retryAfterMs to a generic status error', () => {
    const err = normalizeAPIStatusError(503, 'Service Unavailable', null, {
      retryAfterMs: 3000,
    });
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.retryAfterMs).toBe(3000);
  });

  it('normalizeAPIStatusError keeps retryAfterMs undefined when no options passed', () => {
    const err = normalizeAPIStatusError(429, 'Too Many Requests', 'req-rate');
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses Retry-After integer seconds to ms', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '30' }))).toBe(30_000);
  });

  it('parses Retry-After HTTP-date relative to now, floored at 0', () => {
    const future = new Date('2026-06-20T00:00:10.000Z').toUTCString();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': future }))).toBe(10_000);

    const past = new Date('2026-06-19T00:00:00.000Z').toUTCString();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': past }))).toBe(0);
  });

  it('prefers retry-after-ms over Retry-After', () => {
    const headers = new Headers({ 'retry-after': '30', 'retry-after-ms': '1500' });
    expect(parseRetryAfterMs(headers)).toBe(1500);
  });

  it('parses retry-after-ms as integer milliseconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '2500' }))).toBe(2500);
  });

  it('returns undefined when no retry headers are present', () => {
    expect(parseRetryAfterMs(new Headers({ 'content-type': 'application/json' }))).toBeUndefined();
  });

  it('returns undefined for missing/null/undefined header sources', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('returns undefined for garbage values', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '' }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': 'abc' }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '12.5' }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '-5' }))).toBeUndefined();
  });

  it('falls back to Retry-After when retry-after-ms is garbage', () => {
    const headers = new Headers({ 'retry-after-ms': 'nope', 'retry-after': '10' });
    expect(parseRetryAfterMs(headers)).toBe(10_000);
  });

  it('accepts a header-getter function', () => {
    const get = (name: string): string | null => (name === 'retry-after' ? '5' : null);
    expect(parseRetryAfterMs(get)).toBe(5000);
  });

  it('accepts a plain record (case-insensitive)', () => {
    expect(parseRetryAfterMs({ 'Retry-After': '7' })).toBe(7000);
    expect(parseRetryAfterMs({ 'RETRY-AFTER-MS': '800' })).toBe(800);
  });
});
