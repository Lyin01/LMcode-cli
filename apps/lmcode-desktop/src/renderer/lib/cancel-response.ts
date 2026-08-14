/**
 * Cancellation guard for the composer's stop button.
 *
 * The authoritative signal that a turn has stopped is the `turn.ended` event
 * from the main process — the session store clears streaming and appends the
 * "已停止生成" notice there. This helper therefore never touches streaming
 * state itself: a successful cancel simply waits for that event, and a failed
 * one leaves the (still running) session marked as streaming while surfacing
 * the failure through `onError` as a visible message.
 *
 * Repeated stop clicks while one cancel IPC is in flight are coalesced: the
 * second call resolves as `pending` without issuing another request.
 */
export type CancelResponseResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly error: unknown; readonly message: string }

export interface CancelResponseDeps {
  readonly cancelResponse: (sessionId: string) => Promise<void>
  /** Surface a failed cancellation to the user (e.g. as a system error message). */
  readonly onError?: (message: string, error: unknown) => void
  /** Diagnostic logging hook; kept separate so user-facing text stays clean. */
  readonly logError?: (error: unknown) => void
}

/** Sessions with a cancel IPC currently in flight. */
const pendingSessions = new Set<string>()

export async function cancelResponseSafely(
  sessionId: string,
  deps: CancelResponseDeps,
): Promise<CancelResponseResult> {
  if (pendingSessions.has(sessionId)) return { status: 'pending' }
  pendingSessions.add(sessionId)
  try {
    await deps.cancelResponse(sessionId)
    return { status: 'cancelled' }
  } catch (error) {
    deps.logError?.(error)
    const message = error instanceof Error ? error.message : String(error)
    deps.onError?.(message, error)
    return { status: 'failed', error, message }
  } finally {
    pendingSessions.delete(sessionId)
  }
}
