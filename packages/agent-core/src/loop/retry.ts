import { sleep } from '@antfu/utils';
import * as retry from 'retry';
import { APIContextOverflowError, APIStatusError, isProviderRateLimitError } from '@lmcode-cli/ltod';

import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5000;
const RETRY_FACTOR = 2;

/**
 * Ceiling for rate-limit backoff. Provider rate limits often need far longer
 * than the default 5s cap to clear, so honor server hints (and clamp our own
 * backoff) up to a full minute.
 */
export const RATE_LIMIT_MAX_TIMEOUT_MS = 60_000;

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  readonly log?: Logger | undefined;
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;

  if (input.llm.isRetryableError === undefined || maxAttempts <= 1) {
    const effectiveMaxAttempts = Math.max(maxAttempts, 1);
    try {
      return await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
    } catch (error) {
      logRequestFailure(input, error, 1, effectiveMaxAttempts);
      throw error;
    }
  }

  const delays = retryBackoffDelays(maxAttempts);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await input.llm.chat(paramsForAttempt(input, attempt, maxAttempts));
    } catch (error) {
      // Overflow errors can't be fixed by retrying — they need compaction.
      // Fail fast so the turn-level handler can trigger emergency compaction
      // without wasting retry attempts on the same overflow.
      if (error instanceof APIContextOverflowError) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      if (attempt >= maxAttempts || !input.llm.isRetryableError(error)) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      const delayMs = retryDelayMs(error, delays[attempt - 1] ?? 0);
      input.params.signal.throwIfAborted();
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      });
      await sleepForRetry(delayMs, input.params.signal);
    }
  }
}

function logRequestFailure(
  input: ChatWithRetryInput,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
): LLMChatParams {
  return {
    ...input.params,
    requestLogContext: {
      turnId: input.turnId,
      step: input.currentStep,
      stepUuid: input.stepUuid,
      attempt,
      maxAttempts,
    },
  };
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  return retry.timeouts({
    retries: Math.max(maxAttempts - 1, 0),
    minTimeout: RETRY_MIN_TIMEOUT_MS,
    maxTimeout: RETRY_MAX_TIMEOUT_MS,
    factor: RETRY_FACTOR,
    randomize: true,
  });
}

/**
 * Resolve the delay before the next retry, honoring server hints for rate
 * limits:
 *  - If the error carries a usable `retryAfterMs` (server `Retry-After`),
 *    use it, clamped to {@link RATE_LIMIT_MAX_TIMEOUT_MS}.
 *  - Else if the error is a provider rate-limit, clamp the normal exponential
 *    backoff up to {@link RATE_LIMIT_MAX_TIMEOUT_MS} instead of the 5s default.
 *  - Otherwise use the precomputed (5s-capped) backoff for this attempt.
 */
export function retryDelayMs(error: unknown, backoffDelayMs: number): number {
  const retryAfterMs = retryAfterMsFor(error);
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, RATE_LIMIT_MAX_TIMEOUT_MS);
  }
  if (isProviderRateLimitError(error)) {
    return Math.min(backoffDelayMs * RETRY_FACTOR, RATE_LIMIT_MAX_TIMEOUT_MS);
  }
  return backoffDelayMs;
}

function retryAfterMsFor(error: unknown): number | undefined {
  const raw =
    error instanceof APIStatusError
      ? error.retryAfterMs
      : (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

export async function sleepForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await abortable(sleep(delayMs), signal);
}

interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
