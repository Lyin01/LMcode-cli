import type { Event } from '@lmcode-cli/lmcode-sdk'
import { summarizeOutput } from './format'

/**
 * Pure projection from the SDK event stream (and persisted history) onto the
 * flat list the mobile chat view renders. Kept free of React so both the
 * reducer and the history mapping stay unit-testable.
 */

export interface UserItem {
  readonly kind: 'user'
  readonly id: string
  readonly text: string
}

export interface AssistantItem {
  readonly kind: 'assistant'
  readonly id: string
  readonly text: string
  readonly thinking: string
  /**
   * Set once a turn boundary was observed. A sealed bubble is complete for its
   * turn, so the next turn's deltas must start a new one instead of appending.
   */
  readonly sealed?: boolean
}

export interface ToolItem {
  readonly kind: 'tool'
  readonly id: string
  readonly toolCallId: string
  readonly name: string
  readonly status: 'running' | 'done' | 'error'
  readonly detail?: string | undefined
}

export interface NoticeItem {
  readonly kind: 'notice'
  readonly id: string
  readonly level: 'info' | 'warning' | 'error'
  readonly text: string
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | NoticeItem

export interface TranscriptState {
  readonly items: readonly TranscriptItem[]
  readonly running: boolean
  /** Monotonic id source; part of the state so the reducer stays a pure function. */
  readonly seq: number
}

export function createTranscript(): TranscriptState {
  return { items: [], running: false, seq: 0 }
}

export function appendUserItem(state: TranscriptState, text: string): TranscriptState {
  return appendItem(state, (id) => ({ kind: 'user', id, text }))
}

export function reduceTranscript(state: TranscriptState, event: Event): TranscriptState {
  switch (event.type) {
    case 'turn.started':
      return withRunning(sealAssistant(state), true)
    case 'turn.ended': {
      const ended = withRunning(sealAssistant(state), false)
      return event.error === undefined
        ? ended
        : appendNotice(ended, 'error', event.error.message)
    }
    // Streaming activity is also evidence of an active turn: a client that
    // attached mid-turn never saw `turn.started`, and without this it would
    // report the session as idle, hide the stop button, and send its next
    // message as a fresh prompt the core then refuses.
    case 'assistant.delta':
      return appendAssistantText(withRunning(state, true), event.delta)
    case 'thinking.delta':
      return appendAssistantThinking(withRunning(state, true), event.delta)
    case 'tool.call.started':
      return appendItem(withRunning(state, true), (id) => ({
        kind: 'tool',
        id,
        toolCallId: event.toolCallId,
        name: event.name,
        status: 'running',
      }))
    case 'tool.result':
      return updateTool(
        withRunning(state, true),
        event.toolCallId,
        event.isError === true ? 'error' : 'done',
        summarizeOutput(event.output),
      )
    case 'error':
      return appendNotice(state, 'error', event.message)
    case 'warning':
      return appendNotice(state, 'warning', event.message)
    case 'compaction.completed':
      return appendNotice(
        state,
        'info',
        `上下文已压缩（${event.result.compactedCount} 条消息）`,
      )
    default:
      return state
  }
}

interface HistoryPartLike {
  readonly type?: string
  readonly text?: string
  readonly think?: string
}

interface HistoryMessageLike {
  readonly role?: string
  readonly content?: unknown
  readonly toolCalls?: readonly {
    readonly id?: string
    readonly name?: string
    readonly arguments?: string | null
  }[]
  readonly toolCallId?: string
  readonly origin?: { readonly kind?: string }
}

/**
 * Map persisted conversation history (`sessions.history`) onto the same item
 * shape the live event stream produces. Injected system reminders are skipped
 * and tool results attach to the matching call.
 */
export function historyToTranscript(history: readonly unknown[]): TranscriptState {
  let state = createTranscript()
  for (const raw of history) {
    const message = raw as HistoryMessageLike
    const parts = Array.isArray(message.content) ? (message.content as readonly HistoryPartLike[]) : []
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    const thinking = parts
      .filter((part) => part.type === 'think')
      .map((part) => part.think ?? '')
      .join('')

    if (message.role === 'user') {
      const isRealUser = message.origin === undefined || message.origin.kind === 'user'
      if (isRealUser && text.trim().length > 0) state = appendUserItem(state, text)
      continue
    }
    if (message.role === 'assistant') {
      if (text.trim().length > 0 || thinking.trim().length > 0) {
        state = appendItem(state, (id) => ({ kind: 'assistant', id, text, thinking }))
      }
      for (const call of message.toolCalls ?? []) {
        const record = call
        state = appendItem(state, (id) => ({
          kind: 'tool',
          id,
          toolCallId: record.id ?? id,
          name: record.name ?? '工具',
          status: 'done',
        }))
      }
      continue
    }
    if (message.role === 'tool' && typeof message.toolCallId === 'string') {
      state = updateTool(state, message.toolCallId, 'done', summarizeOutput(text))
    }
  }
  return state
}

function appendItem(
  state: TranscriptState,
  create: (id: string) => TranscriptItem,
): TranscriptState {
  const seq = state.seq + 1
  return { ...state, seq, items: [...state.items, create(`item-${seq}`)] }
}

function appendNotice(
  state: TranscriptState,
  level: NoticeItem['level'],
  text: string,
): TranscriptState {
  return appendItem(state, (id) => ({ kind: 'notice', id, level, text }))
}

function withRunning(state: TranscriptState, running: boolean): TranscriptState {
  return state.running === running ? state : { ...state, running }
}

/**
 * Seals the trailing assistant bubble when a turn boundary is observed: the
 * next turn's deltas must start a new bubble rather than append to the
 * previous answer. A bubble that was never sealed — e.g. one hydrated from
 * history while the current turn is still streaming — keeps absorbing deltas.
 */
function sealAssistant(state: TranscriptState): TranscriptState {
  const last = state.items[state.items.length - 1]
  if (last?.kind !== 'assistant' || last.sealed === true) return state
  const items = [...state.items]
  items[items.length - 1] = { ...last, sealed: true }
  return { ...state, items }
}

function appendAssistantText(state: TranscriptState, text: string): TranscriptState {
  const last = state.items[state.items.length - 1]
  if (last?.kind === 'assistant' && last.sealed !== true) {
    const items = [...state.items]
    items[items.length - 1] = { ...last, text: last.text + text }
    return { ...state, items }
  }
  return appendItem(state, (id) => ({ kind: 'assistant', id, text, thinking: '' }))
}

function appendAssistantThinking(state: TranscriptState, text: string): TranscriptState {
  const last = state.items[state.items.length - 1]
  if (last?.kind === 'assistant' && last.sealed !== true) {
    const items = [...state.items]
    items[items.length - 1] = { ...last, thinking: last.thinking + text }
    return { ...state, items }
  }
  return appendItem(state, (id) => ({ kind: 'assistant', id, text: '', thinking: text }))
}

function updateTool(
  state: TranscriptState,
  toolCallId: string,
  status: ToolItem['status'],
  detail: string | undefined,
): TranscriptState {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (item?.kind !== 'tool' || item.toolCallId !== toolCallId) continue
    const items = [...state.items]
    items[index] = detail === undefined ? { ...item, status } : { ...item, status, detail }
    return { ...state, items }
  }
  return state
}
