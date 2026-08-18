/**
 * Wait for an eval session to go idle, including goal-drive follow-up turns.
 *
 * Kept free of the SDK runtime import so the waiter can be unit-tested from
 * `evals/` (which is outside the workspace package graph).
 */

export interface EvalSessionEvent {
  readonly type: string;
  readonly turnId?: number | undefined;
  readonly reason?: string | undefined;
  readonly error?: { readonly message?: unknown } | undefined;
  readonly message?: unknown;
}

export interface EvalSessionEventSource {
  onEvent(listener: (event: EvalSessionEvent) => void): () => void;
}

/**
 * Wait until every in-flight turn has ended.
 *
 * `CreateGoal` during a standalone turn emits `turn.ended` and then, on the
 * same call stack, starts `driveGoal` with a new `turn.started`. Settling in
 * the `turn.ended` listener would score before that handoff. A microtask
 * deferral runs after the synchronous follow-up `turn.started`, so idle means
 * the goal drive (if any) has also finished.
 *
 * The last `turn.ended` is returned so the caller can inspect `reason`.
 */
export function waitForSessionIdle(
  session: EvalSessionEventSource,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<EvalSessionEvent> {
  return new Promise((resolve, reject) => {
    let inFlight = 0;
    let lastEnded: EvalSessionEvent | undefined;
    let settled = false;
    let idleCheck: Promise<void> | undefined;

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for session idle`));
      });
    }, timeoutMs);

    const onAbort = (): void => {
      finish(() => {
        reject(new Error('session idle wait aborted'));
      });
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      fn();
    };

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const scheduleIdleCheck = (): void => {
      if (idleCheck !== undefined) return;
      idleCheck = Promise.resolve().then(() => {
        idleCheck = undefined;
        if (settled || inFlight !== 0 || lastEnded === undefined) return;
        const ended = lastEnded;
        finish(() => {
          resolve(ended);
        });
      });
    };

    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'turn.started') {
        inFlight += 1;
        return;
      }
      if (event.type !== 'turn.ended') return;
      inFlight = Math.max(0, inFlight - 1);
      lastEnded = event;
      scheduleIdleCheck();
    });
  });
}

function turnFailureMessage(event: EvalSessionEvent): string {
  if (event.type !== 'turn.ended') return 'turn ended abnormally';
  if (event.reason === 'cancelled') return 'turn cancelled';
  if (event.reason === 'failed') {
    const message = event.error?.message;
    return typeof message === 'string' && message.length > 0
      ? message
      : 'turn ended with failure';
  }
  return 'turn ended abnormally';
}

/** Message when the last turn should fail the eval run; otherwise `undefined`. */
export function abnormalTurnMessage(event: EvalSessionEvent): string | undefined {
  if (event.type !== 'turn.ended') return undefined;
  if (event.reason === 'failed' || event.reason === 'cancelled') {
    return turnFailureMessage(event);
  }
  return undefined;
}
