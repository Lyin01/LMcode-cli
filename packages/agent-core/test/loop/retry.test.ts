import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIStatusError,
  emptyUsage,
  isRetryableGenerateError,
} from '@lmcode-cli/ltod';
import { describe, expect, it } from 'vitest';

import type { LoopEvent } from '#/loop/events';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { chatWithRetry, RATE_LIMIT_MAX_TIMEOUT_MS, retryDelayMs } from '#/loop/retry';

function okResponse(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeInput(
  llm: LLM,
  signal: AbortSignal,
  dispatchEvent: Parameters<typeof chatWithRetry>[0]['dispatchEvent'] = (async () => {}) as Parameters<
    typeof chatWithRetry
  >[0]['dispatchEvent'],
): Parameters<typeof chatWithRetry>[0] {
  return {
    llm,
    params: { messages: [], tools: [], signal },
    dispatchEvent,
    turnId: 't',
    currentStep: 1,
    stepUuid: 'u',
  };
}

function capturingDispatcher(events: LoopEvent[]): Parameters<typeof chatWithRetry>[0]['dispatchEvent'] {
  return ((event: LoopEvent) => {
    events.push(event);
    return Promise.resolve();
  }) as Parameters<typeof chatWithRetry>[0]['dispatchEvent'];
}

describe('chatWithRetry: terminated stream drops', () => {
  it('retries an APIConnectionError("terminated") and succeeds on a later attempt', async () => {
    // A mid-stream `terminated` is classified as a retryable APIConnectionError,
    // so an intermittent connection drop should be recovered transparently.
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };

    const response = await chatWithRetry(makeInput(llm, new AbortController().signal));

    expect(calls).toBe(2);
    expect(response).toEqual(okResponse());
  });

  it('does NOT retry when the signal is aborted (user ESC), surfacing a clean AbortError', async () => {
    // Even though `terminated` is retryable, a user-aborted request must never
    // be retried: the abort signal is checked before any retry, so it surfaces
    // as an AbortError rather than a provider error.
    let calls = 0;
    const ac = new AbortController();
    ac.abort();

    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(llm, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
  });
});

describe('retryDelayMs', () => {
  it('honors a server retryAfterMs hint, clamped to the rate-limit ceiling', () => {
    const err = new APIProviderRateLimitError('rate limited', null, 30_000);
    expect(retryDelayMs(err, 1000)).toBe(30_000);
  });

  it('clamps an over-large retryAfterMs to RATE_LIMIT_MAX_TIMEOUT_MS', () => {
    const err = new APIStatusError(503, 'unavailable', null, 10 * 60_000);
    expect(retryDelayMs(err, 1000)).toBe(RATE_LIMIT_MAX_TIMEOUT_MS);
  });

  it('duck-types retryAfterMs off non-APIStatusError values', () => {
    const err = Object.assign(new Error('rate limited'), { retryAfterMs: 4000 });
    expect(retryDelayMs(err, 1000)).toBe(4000);
  });

  it('ignores garbage retryAfterMs values', () => {
    const negative = new APIStatusError(503, 'x', null, -5);
    expect(retryDelayMs(negative, 1000)).toBe(1000);
  });

  it('ignores a NaN retryAfterMs (malformed Retry-After header)', () => {
    // typeof NaN === 'number' passes, but Number.isFinite(NaN) is false, so the
    // guard must reject it and fall back to the precomputed backoff.
    const err = new APIStatusError(503, 'x', null, NaN);
    expect(retryDelayMs(err, 1000)).toBe(1000);
  });

  it('ignores an Infinity retryAfterMs', () => {
    const err = new APIStatusError(503, 'x', null, Infinity);
    expect(retryDelayMs(err, 1000)).toBe(1000);
  });

  it('ignores a non-numeric duck-typed retryAfterMs', () => {
    const err = Object.assign(new Error('x'), { retryAfterMs: 'soon' });
    expect(retryDelayMs(err, 1000)).toBe(1000);
  });

  it('honors a zero retryAfterMs (retry immediately)', () => {
    // The guard is `raw >= 0`, not `> 0`: a server asking to retry with no
    // delay must be honored as 0, not discarded as garbage.
    const err = new APIStatusError(503, 'x', null, 0);
    expect(retryDelayMs(err, 1000)).toBe(0);
  });

  it('clamps rate-limit backoff above 5s when no hint is present', () => {
    // A provider rate-limit with no Retry-After: the normal backoff is scaled
    // up (× factor) and allowed to exceed the 5s default cap.
    const err = new APIProviderRateLimitError('rate limited');
    expect(retryDelayMs(err, 5000)).toBe(10_000);
  });

  it('caps the scaled rate-limit backoff at RATE_LIMIT_MAX_TIMEOUT_MS', () => {
    const err = new APIProviderRateLimitError('rate limited');
    expect(retryDelayMs(err, 40_000)).toBe(RATE_LIMIT_MAX_TIMEOUT_MS);
  });

  it('uses the plain backoff for non-rate-limit retryable errors', () => {
    const err = new APIConnectionError('terminated');
    expect(retryDelayMs(err, 1234)).toBe(1234);
  });
});

describe('chatWithRetry: honors retry-after in the loop', () => {
  it('sleeps for the server-provided retryAfterMs and reports it in step.retrying', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        // 0ms hint keeps the test fast while still exercising the hint path.
        if (calls === 1) throw new APIProviderRateLimitError('rate limited', null, 0);
        return okResponse();
      },
    };

    const events: LoopEvent[] = [];
    const response = await chatWithRetry(
      makeInput(llm, new AbortController().signal, capturingDispatcher(events)),
    );

    expect(calls).toBe(2);
    expect(response).toEqual(okResponse());

    const retrying = events.find((e) => e.type === 'step.retrying');
    expect(retrying).toBeDefined();
    expect(retrying).toMatchObject({ type: 'step.retrying', delayMs: 0, statusCode: 429 });
  });
});
