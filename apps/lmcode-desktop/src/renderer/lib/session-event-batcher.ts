import type {
  AssistantDeltaEvent,
  Event,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
} from '@lmcode-cli/lmcode-sdk'

/**
 * Batching window for streaming text. One store publication per window instead
 * of one per delta: with D deltas over M messages, the per-delta reducer copies
 * the message array D×M times and the markdown pipeline re-parses the whole
 * accumulated string every time.
 */
const BATCH_WINDOW_MS = 16

type TextDeltaEvent = Event & (AssistantDeltaEvent | ThinkingDeltaEvent)
type BatchableEvent = TextDeltaEvent | (Event & ToolCallDeltaEvent)
type BatchField = 'delta' | 'argumentsPart'

/**
 * One ordered run of adjacent deltas sharing the same session, event type,
 * main-agent identity, and turn (and toolCallId for tool argument streams).
 * Chunks are joined exactly once, at flush.
 */
interface PendingSegment {
  readonly key: string
  readonly sessionId: string
  readonly field: BatchField
  event: BatchableEvent
  readonly chunks: string[]
}

/** Token for the scheduled flush. `hasToken` covers schedulers that fire synchronously. */
interface ScheduledFlush {
  active: boolean
  hasToken: boolean
  token: unknown
}

export interface SessionEventBatcherOptions {
  readonly schedule?: (callback: () => void) => unknown
  readonly cancel?: (token: unknown) => void
}

export interface SessionEventBatcher {
  push: (sessionId: string, event: Event) => void
  /** Synchronously dispatch every pending segment; returns how many there were. */
  flush: () => number
  pendingCount: () => number
  /** Flush whatever is pending and reject all later events. */
  dispose: () => void
}

function defaultSchedule(callback: () => void): unknown {
  return globalThis.setTimeout(callback, BATCH_WINDOW_MS)
}

function defaultCancel(token: unknown): void {
  globalThis.clearTimeout(token as number)
}

function identityPart(value: string | number | null | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  return `${typeof value}:${value}`
}

/**
 * Segment boundary key. Only main-agent deltas are batched, so the agent slot
 * is a constant; turn/session/type differences always start a new segment,
 * which keeps interleaved streams (`t1:A → t2:B → t1:C`) in arrival order.
 */
function segmentKey(sessionId: string, event: BatchableEvent): string {
  const parts = [identityPart(sessionId), event.type, 'main', identityPart(event.turnId)]
  if (event.type === 'tool.call.delta') parts.push(identityPart(event.toolCallId))
  return parts.join('\u0000')
}

function isMainAgent(event: Event): boolean {
  const agentId = event.agentId as string | null | undefined
  return agentId === undefined || agentId === 'main'
}

/**
 * Batchable events are main-agent text deltas and tool-argument fragments.
 * Events without an agentId (older main processes) are treated as main,
 * matching the store's filter; `null` and sub-agent ids are NOT — they pass
 * through unbatched as segment barriers so their data can never be merged
 * into the main stream.
 */
function isBatchable(event: Event): event is BatchableEvent {
  if (!isMainAgent(event)) return false
  if (event.type === 'assistant.delta' || event.type === 'thinking.delta') {
    return typeof (event as TextDeltaEvent).delta === 'string'
  }
  if (event.type === 'tool.call.delta') {
    return typeof (event as ToolCallDeltaEvent).argumentsPart === 'string'
  }
  return false
}

function chunkOf(event: BatchableEvent): string {
  if (event.type === 'tool.call.delta') return event.argumentsPart ?? ''
  return event.delta
}

function fieldOf(event: BatchableEvent): BatchField {
  return event.type === 'tool.call.delta' ? 'argumentsPart' : 'delta'
}

/**
 * Collects adjacent assistant/thinking deltas into ordered segments and
 * publishes each segment as a single event. Every non-delta event first
 * flushes pending text synchronously, so downstream consumers observe the
 * exact arrival order; reducer-visible state is unchanged, only the
 * publication frequency drops.
 */
export function createSessionEventBatcher(
  dispatch: (sessionId: string, event: Event) => void,
  options: SessionEventBatcherOptions = {},
): SessionEventBatcher {
  const schedule = options.schedule ?? defaultSchedule
  const cancel = options.cancel ?? defaultCancel
  const pending: PendingSegment[] = []
  let scheduled: ScheduledFlush | null = null
  let disposed = false

  const flushPending = (): number => {
    if (pending.length === 0) return 0
    const segments = pending.splice(0, pending.length)
    for (const segment of segments) {
      dispatch(segment.sessionId, {
        ...segment.event,
        [segment.field]: segment.chunks.join(''),
      } as BatchableEvent)
    }
    return segments.length
  }

  const cancelScheduled = (): void => {
    const marker = scheduled
    if (marker === null) return
    scheduled = null
    marker.active = false
    if (marker.hasToken) cancel(marker.token)
  }

  const flush = (): number => {
    cancelScheduled()
    return flushPending()
  }

  const scheduleFlush = (): void => {
    if (scheduled !== null) return
    const marker: ScheduledFlush = { active: true, hasToken: false, token: undefined }
    scheduled = marker
    const token = schedule(() => {
      if (!marker.active) return
      marker.active = false
      if (scheduled === marker) scheduled = null
      flushPending()
    })
    marker.token = token
    marker.hasToken = true
  }

  const push = (sessionId: string, event: Event): void => {
    if (disposed) return
    if (!isBatchable(event)) {
      flush()
      dispatch(sessionId, event)
      return
    }

    const key = segmentKey(sessionId, event)
    const current = pending.at(-1)
    const chunk = chunkOf(event)
    if (current?.key === key) {
      current.event = { ...event }
      current.chunks.push(chunk)
    } else {
      pending.push({
        key,
        sessionId,
        field: fieldOf(event),
        event: { ...event },
        chunks: [chunk],
      })
    }
    scheduleFlush()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    flush()
  }

  return {
    dispose,
    flush,
    pendingCount: () => pending.length,
    push,
  }
}
