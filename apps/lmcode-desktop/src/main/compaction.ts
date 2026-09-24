import type { Event } from '@lmcode-cli/lmcode-sdk'
import type { CompactSessionOutcome } from '../shared/ipc-types.js'

/**
 * Structural subset of an SDK session the manual-compaction wait touches.
 * Keeping it structural lets tests drive the wait without an agent runtime.
 */
export interface CompactionSessionLike {
  compact(options: { readonly instruction?: string }): Promise<void>
  onEvent(listener: (event: Event) => void): () => void
}

/** `ErrorCodes.COMPACTION_FAILED` in agent-core — emitted when a compaction
 *  worker dies (provider failure, persistence failure, …). */
const COMPACTION_FAILED_CODE = 'compaction.failed'

/**
 * Ceiling for how long a manual `/compact` waits for a terminal event before
 * reporting that the outcome is unknown. A large context can legitimately take
 * minutes to summarize (plus retries), so this sits well above the runtime of
 * any healthy compaction.
 */
export const COMPACTION_WAIT_TIMEOUT_MS = 15 * 60_000

/**
 * A failed compaction emits `compaction.cancelled` (with no reason) immediately
 * before its COMPACTION_FAILED error. Both events travel the same RPC channel
 * in order, so delaying the cancellation verdict by this grace window lets the
 * failure win — otherwise a hard failure would be misreported as a plain
 * cancellation.
 */
export const COMPACTION_FAILURE_GRACE_MS = 250

export interface CompactSessionWaitOptions {
  readonly timeoutMs?: number
}

/**
 * Start a manual compaction and resolve with its *real* outcome.
 *
 * `Session.compact()` maps to the agent's `beginCompaction` RPC, which only
 * kicks off an asynchronous summarization worker and acknowledges the begin.
 * Treating that acknowledgement as completion is why `/compact` painted
 * “上下文压缩完成。” within milliseconds while the compaction was still running
 * (or had already failed). This wraps the begin-ack into a promise that settles
 * on the session's own compaction events instead.
 */
export async function compactSessionAndWait(
  session: CompactionSessionLike,
  instruction: string | undefined,
  options: CompactSessionWaitOptions = {},
): Promise<CompactSessionOutcome> {
  const startedAt = Date.now()
  const elapsedMs = (): number => Math.max(0, Date.now() - startedAt)
  const watch = watchCompactionTerminal(
    session,
    options.timeoutMs ?? COMPACTION_WAIT_TIMEOUT_MS,
    elapsedMs,
  )

  try {
    await session.compact(instruction === undefined ? {} : { instruction })
  } catch (error) {
    // The begin itself was rejected (nothing left to compact, session busy…):
    // nothing is in flight, so tear the watcher down and surface the error.
    watch.dispose()
    throw error
  }

  return await watch.outcome
}

interface CompactionWatch {
  readonly outcome: Promise<CompactSessionOutcome>
  dispose(): void
}

function watchCompactionTerminal(
  session: CompactionSessionLike,
  timeoutMs: number,
  elapsedMs: () => number,
): CompactionWatch {
  let settleOutcome: ((outcome: CompactSessionOutcome) => void) | undefined
  let unsubscribe: (() => void) | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let settled = false

  const close = (): void => {
    if (closed) return
    closed = true
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    unsubscribe?.()
  }

  const finish = (outcome: CompactSessionOutcome): void => {
    if (settled) return
    settled = true
    close()
    settleOutcome?.(outcome)
  }

  const outcome = new Promise<CompactSessionOutcome>((resolve) => {
    settleOutcome = resolve
  })

  unsubscribe = session.onEvent((event) => {
    switch (event.type) {
      case 'compaction.completed':
        finish({
          outcome: 'completed',
          compactedCount: event.result.compactedCount,
          tokensBefore: event.result.tokensBefore,
          tokensAfter: event.result.tokensAfter,
          elapsedMs: elapsedMs(),
        })
        return
      case 'compaction.cancelled':
        if (event.reason !== undefined) {
          finish({ outcome: 'cancelled', reason: event.reason, elapsedMs: elapsedMs() })
          return
        }
        // Reasonless cancellation: give a trailing COMPACTION_FAILED error a
        // beat to arrive before deciding between "failed" and "cancelled".
        graceTimer ??= setTimeout(() => {
          finish({ outcome: 'cancelled', elapsedMs: elapsedMs() })
        }, COMPACTION_FAILURE_GRACE_MS)
        return
      case 'error':
        if (event.code === COMPACTION_FAILED_CODE) {
          finish({ outcome: 'failed', message: event.message, elapsedMs: elapsedMs() })
        }
        return
      default:
        return
    }
  })

  timeoutTimer = setTimeout(() => {
    finish({ outcome: 'pending', elapsedMs: elapsedMs() })
  }, timeoutMs)
  timeoutTimer.unref?.()

  return { outcome, dispose: close }
}
