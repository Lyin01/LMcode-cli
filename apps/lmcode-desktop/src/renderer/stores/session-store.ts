import { create } from 'zustand'
import type {
  Message,
  PendingInteraction,
  QueuedUserMessage,
  SessionInfo,
  ToolCallInfo,
  UserAttachment,
} from '@/types'
import {
  DEFAULT_THINKING_EFFORT,
  getStoredThinking,
  setStoredThinking,
  type ThinkingEffort,
} from '@/lib/thinking'
import type {
  Event,
  TurnEndedEvent,
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolProgressEvent,
  ToolResultEvent,
  AgentStatusUpdatedEvent,
  SessionMetaUpdatedEvent,
  ErrorEvent,
  WarningEvent,
  TurnStepRetryingEvent,
  TurnStepInterruptedEvent,
} from '@lmcode-cli/lmcode-sdk'

let msgCounter = 0
let queuedMessageCounter = 0
function nextMsgId(): string {
  msgCounter += 1
  return `msg_${Date.now()}_${msgCounter}`
}

/**
 * The per-session streaming state. Each session — whether currently in view or
 * running in the background — owns one of these. Keeping them separate is what
 * lets a task started in session A keep streaming (and stay intact) while the
 * user works in session B, instead of the view being wiped on switch.
 */
interface SessionSlice {
  messages: Message[]
  isStreaming: boolean
  streamStatus: string | null
}

const EMPTY_SLICE: SessionSlice = { messages: [], isStreaming: false, streamStatus: null }

interface BackgroundSessionSlice extends SessionSlice {
  readonly unread: boolean
}

const EMPTY_BACKGROUND_SLICE: BackgroundSessionSlice = {
  ...EMPTY_SLICE,
  unread: false,
}

/** Replace the last assistant message in `msgs` with `fn(msg)`, returning a new array. */
function patchLastAssistant(msgs: Message[], fn: (m: Message) => Message): Message[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'assistant') {
      const copy = msgs.slice()
      copy[i] = fn(msgs[i]!)
      return copy
    }
  }
  return msgs
}

/**
 * Pure reducer: apply one streaming Event to a session slice and return the new
 * slice. Used for both the in-view session and background sessions, so they
 * render identically whether or not they are the active tab.
 */
function reduceMessageEvent(slice: SessionSlice, event: Event): SessionSlice {
  const msgs = slice.messages

  switch (event.type) {
    case 'turn.started': {
      const msg: Message = {
        id: nextMsgId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        thinkingState: 'streaming',
        toolCalls: [],
      }
      return { messages: [...msgs, msg], isStreaming: true, streamStatus: null }
    }

    case 'assistant.delta': {
      const ev = event as AssistantDeltaEvent
      return {
        ...slice,
        messages: patchLastAssistant(msgs, (m) => ({ ...m, content: m.content + ev.delta })),
        streamStatus: null,
      }
    }

    case 'thinking.delta': {
      const ev = event as ThinkingDeltaEvent
      return {
        ...slice,
        messages: patchLastAssistant(msgs, (m) => ({
          ...m,
          thinking: (m.thinking ?? '') + ev.delta,
          thinkingState: 'streaming',
        })),
        streamStatus: null,
      }
    }

    case 'tool.call.started': {
      const ev = event as ToolCallStartedEvent
      const toolCall: ToolCallInfo = {
        id: ev.toolCallId,
        toolName: ev.name,
        args: JSON.stringify(ev.args, null, 2),
        status: 'running',
      }
      return {
        ...slice,
        messages: patchLastAssistant(msgs, (m) => ({
          ...m,
          toolCalls: [...(m.toolCalls ?? []), toolCall],
        })),
      }
    }

    case 'tool.call.delta': {
      const ev = event as ToolCallDeltaEvent
      return {
        ...slice,
        messages: patchLastAssistant(msgs, (m) =>
          m.toolCalls
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.id === ev.toolCallId
                    ? {
                        ...tc,
                        ...(ev.name ? { toolName: ev.name } : {}),
                        ...(ev.argumentsPart ? { args: tc.args + ev.argumentsPart } : {}),
                      }
                    : tc,
                ),
              }
            : m,
        ),
      }
    }

    case 'tool.result': {
      const ev = event as ToolResultEvent
      return {
        ...slice,
        messages: patchLastAssistant(msgs, (m) =>
          m.toolCalls
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.id === ev.toolCallId
                    ? {
                        ...tc,
                        status: ev.isError ? ('failed' as const) : ('completed' as const),
                        result:
                          typeof ev.output === 'string'
                            ? ev.output
                            : JSON.stringify(ev.output, null, 2),
                      }
                    : tc,
                ),
              }
            : m,
        ),
      }
    }

    case 'tool.progress': {
      // Long-running tools can report interim updates; surface the latest one
      // on the tool card instead of dropping the event on the floor.
      const ev = event as ToolProgressEvent
      const text =
        ev.update.text ??
        (typeof ev.update.percent === 'number'
          ? `${Math.round(ev.update.percent)}%`
          : undefined)
      if (text === undefined) return slice
      return {
        ...slice,
        messages: patchLastAssistant(msgs, (m) =>
          m.toolCalls
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) =>
                  tc.id === ev.toolCallId ? { ...tc, progress: text } : tc,
                ),
              }
            : m,
        ),
      }
    }

    case 'turn.ended': {
      const ev = event as TurnEndedEvent
      let lastAssistant: Message | undefined
      const patched = patchLastAssistant(msgs, (m) => {
        const u: Message = { ...m, thinkingState: m.thinking ? 'complete' : undefined }
        lastAssistant = u
        return u
      })
      const extra: Message[] = []
      // A turn can end without the model ever emitting a closing summary — it
      // failed, was cancelled, or (rarely) completed silently. Make that visible
      // rather than leaving an empty assistant bubble that looks "stuck".
      if (ev.reason === 'failed') {
        extra.push({
          id: nextMsgId(),
          role: 'system',
          variant: 'error',
          content: `回合失败：${ev.error?.message ?? '未知错误'}`,
          timestamp: Date.now(),
        })
      } else if (ev.reason === 'cancelled') {
        extra.push({
          id: nextMsgId(),
          role: 'system',
          variant: 'notice',
          content: '已停止生成',
          timestamp: Date.now(),
        })
      } else if (
        ev.reason === 'completed' &&
        lastAssistant &&
        !lastAssistant.content.trim() &&
        (lastAssistant.toolCalls?.length ?? 0) > 0
      ) {
        extra.push({
          id: nextMsgId(),
          role: 'system',
          variant: 'notice',
          content: '（本回合执行了操作，但模型未输出文字总结）',
          timestamp: Date.now(),
        })
      }
      return { messages: [...patched, ...extra], isStreaming: false, streamStatus: null }
    }

    case 'error': {
      const ev = event as ErrorEvent
      const lastMessage = msgs.at(-1)
      if (
        lastMessage?.role === 'system' &&
        lastMessage.variant === 'error' &&
        lastMessage.content === `回合失败：${ev.message}`
      ) {
        return slice
      }
      return {
        messages: [
          ...msgs,
          {
            id: nextMsgId(),
            role: 'system',
            variant: 'error',
            content: `出错了：${ev.message}${ev.retryable ? '（可重试）' : ''}`,
            timestamp: Date.now(),
          },
        ],
        isStreaming: false,
        streamStatus: null,
      }
    }

    case 'warning': {
      const ev = event as WarningEvent
      return {
        ...slice,
        messages: [
          ...msgs,
          {
            id: nextMsgId(),
            role: 'system',
            variant: 'notice',
            content: `提示：${ev.message}`,
            timestamp: Date.now(),
          },
        ],
      }
    }

    case 'turn.step.retrying': {
      const ev = event as TurnStepRetryingEvent
      return {
        ...slice,
        streamStatus: `网络/模型异常，正在重试（${ev.nextAttempt}/${ev.maxAttempts}）…${
          ev.errorMessage ? ` ${ev.errorMessage}` : ''
        }`,
      }
    }

    case 'turn.step.interrupted': {
      const ev = event as TurnStepInterruptedEvent
      return { ...slice, streamStatus: `已中断：${ev.message ?? ev.reason}` }
    }

    default:
      return slice
  }
}

export interface SessionStore {
  currentSessionId: string | null
  sessions: SessionInfo[]
  // ── Active (in-view) session slice ──
  messages: Message[]
  isStreaming: boolean
  /** Transient status line shown while streaming (e.g. retry / interrupt notices). */
  streamStatus: string | null
  /** Parked slices for sessions that are not in view but may still be streaming. */
  bg: Record<string, BackgroundSessionSlice>

  model: string
  thinkingLevel: ThinkingEffort
  permission: string
  contextTokens: number
  maxContextTokens: number

  pendingInteractions: PendingInteraction[]
  messageQueue: Record<string, QueuedUserMessage[]>

  setSessions: (sessions: SessionInfo[]) => void
  removeDeletedSession: (deletedId: string, remaining: SessionInfo[]) => void
  selectSession: (id: string) => void
  createSession: (workDir?: string) => Promise<void>
  adoptSession: (summary: SessionSummary) => void
  addMessage: (msg: Message) => void
  addMessageToSession: (sessionId: string, msg: Message) => void
  setMessages: (msgs: Message[]) => void
  setMessagesForSession: (sessionId: string, msgs: Message[]) => void
  updateLastAssistantMessage: (updates: Partial<Message>) => void
  appendToLastMessage: (text: string) => void
  setSessionStreaming: (sessionId: string, val: boolean) => void
  updateSessionStatus: (status: Partial<SessionInfo>) => void
  handleEvent: (sessionId: string, event: Event) => void
  clearMessages: () => void
  /** True if the given session is streaming, whether it's in view or backgrounded. */
  isSessionStreaming: (id: string) => boolean

  setThinkingPreference: (level: ThinkingEffort) => Promise<void>
  applyThinkingPreference: (sessionId: string) => Promise<void>
  hydrateThinkingPreference: () => void

  enqueuePendingInteraction: (interaction: PendingInteraction) => void
  completePendingInteraction: (requestId: string) => void
  discardPendingInteraction: (requestId: string) => void

  enqueueMessage: (
    sessionId: string,
    text: string,
    attachments?: readonly UserAttachment[],
  ) => string
  updateQueuedMessage: (sessionId: string, messageId: string, text: string) => void
  removeQueuedMessage: (sessionId: string, messageId: string) => void
  moveQueuedMessage: (sessionId: string, messageId: string, direction: -1 | 1) => void
  shiftQueuedMessage: (sessionId: string) => QueuedUserMessage | undefined
}

function createNewSession(sessionId: string, overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: sessionId,
    workDir: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    thinkingLevel: DEFAULT_THINKING_EFFORT,
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 128000,
    isStreaming: false,
    ...overrides,
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  currentSessionId: null,
  sessions: [],
  messages: [],
  isStreaming: false,
  streamStatus: null,
  bg: {},

  model: '',
  thinkingLevel: DEFAULT_THINKING_EFFORT,
  permission: 'manual',
  contextTokens: 0,
  maxContextTokens: 128000,

  pendingInteractions: [],
  messageQueue: {},

  setSessions: (sessions) => set({ sessions }),

  removeDeletedSession: (deletedId, remaining) =>
    set((state) => {
      const bg = { ...state.bg }
      const messageQueue = { ...state.messageQueue }
      const pendingInteractions = state.pendingInteractions.filter(
        (interaction) => interaction.payload.sessionId !== deletedId,
      )
      delete bg[deletedId]
      delete messageQueue[deletedId]

      if (state.currentSessionId !== deletedId) {
        return { sessions: remaining, bg, messageQueue, pendingInteractions }
      }

      const next = remaining[0]
      if (!next) {
        return {
          sessions: remaining,
          bg,
          messageQueue,
          pendingInteractions,
          currentSessionId: null,
          messages: [],
          isStreaming: false,
          streamStatus: null,
          model: '',
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 128000,
        }
      }

      const restored = bg[next.id]
      delete bg[next.id]
      return {
        sessions: remaining,
        bg,
        messageQueue,
        pendingInteractions,
        currentSessionId: next.id,
        messages: restored?.messages ?? [],
        isStreaming: restored?.isStreaming ?? false,
        streamStatus: restored?.streamStatus ?? null,
        model: next.model ?? '',
        permission: next.permission,
        contextTokens: next.contextTokens,
        maxContextTokens: next.maxContextTokens,
      }
    }),

  selectSession: (id) => {
    const state = get()
    if (id === state.currentSessionId) return
    const session = state.sessions.find((s) => s.id === id)
    if (!session) return

    // Park the session we're leaving so its in-flight stream keeps accumulating
    // (its events route into `bg`) and is restored intact when we come back.
    const bg = { ...state.bg }
    if (state.currentSessionId) {
      bg[state.currentSessionId] = {
        messages: state.messages,
        isStreaming: state.isStreaming,
        streamStatus: state.streamStatus,
        unread: false,
      }
    }
    const restored = bg[id]
    delete bg[id]

    set({
      bg,
      currentSessionId: id,
      messages: restored?.messages ?? [],
      isStreaming: restored?.isStreaming ?? false,
      streamStatus: restored?.streamStatus ?? null,
      model: session.model ?? '',
      thinkingLevel: get().thinkingLevel,
      permission: session.permission,
      contextTokens: session.contextTokens,
      maxContextTokens: session.maxContextTokens,
    })
  },

  createSession: async (requestedWorkDir) => {
    try {
      let workDir = requestedWorkDir?.trim()
      if (!workDir) {
        const current = get().sessions.find((session) => session.id === get().currentSessionId)
        workDir = await window.lmcodeAPI.selectWorkDirectory(current?.workDir)
      }
      if (!workDir) return

      const thinkingLevel = get().thinkingLevel
      const summary = await window.lmcodeAPI.createSession({
        workDir,
        thinking: thinkingLevel,
      })
      get().adoptSession(summary)
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  },

  adoptSession: (summary) => {
    const state = get()
    const newSession = createNewSession(summary.id, {
      title: summary.title,
      workDir: summary.workDir,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      permission: state.permission,
    })
    set((current) => {
      const bg = { ...current.bg }
      if (current.currentSessionId && current.currentSessionId !== summary.id) {
        bg[current.currentSessionId] = {
          messages: current.messages,
          isStreaming: current.isStreaming,
          streamStatus: current.streamStatus,
          unread: false,
        }
      }
      delete bg[summary.id]
      return {
        bg,
        sessions: [
          newSession,
          ...current.sessions.filter((session) => session.id !== summary.id),
        ],
        currentSessionId: summary.id,
        messages: [],
        isStreaming: false,
        streamStatus: null,
        model: newSession.model ?? '',
        permission: newSession.permission,
        contextTokens: newSession.contextTokens,
        maxContextTokens: newSession.maxContextTokens,
      }
    })
  },

  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),

  addMessageToSession: (sessionId, msg) =>
    set((state) => {
      if (state.currentSessionId === sessionId) {
        return { messages: [...state.messages, msg] }
      }
      const previous = state.bg[sessionId] ?? EMPTY_BACKGROUND_SLICE
      return {
        bg: {
          ...state.bg,
          [sessionId]: {
            ...previous,
            messages: [...previous.messages, msg],
            unread: true,
          },
        },
      }
    }),

  setMessages: (msgs) => set({ messages: msgs }),

  setMessagesForSession: (sessionId, msgs) =>
    set((state) => {
      if (state.currentSessionId === sessionId) return { messages: msgs }
      const previous = state.bg[sessionId] ?? EMPTY_BACKGROUND_SLICE
      return {
        bg: {
          ...state.bg,
          [sessionId]: {
            ...previous,
            messages: msgs,
            unread: true,
          },
        },
      }
    }),

  updateLastAssistantMessage: (updates) =>
    set((state) => ({
      messages: patchLastAssistant(state.messages, (m) => ({ ...m, ...updates })),
    })),

  appendToLastMessage: (text) =>
    set((state) => ({
      messages: patchLastAssistant(state.messages, (m) => ({ ...m, content: m.content + text })),
    })),

  setSessionStreaming: (sessionId, val) =>
    set((state) => {
      if (state.currentSessionId === sessionId) {
        return {
          isStreaming: val,
          ...(!val ? { streamStatus: null } : {}),
        }
      }
      const previous = state.bg[sessionId] ?? EMPTY_BACKGROUND_SLICE
      return {
        bg: {
          ...state.bg,
          [sessionId]: {
            ...previous,
            isStreaming: val,
            ...(!val ? { streamStatus: null } : {}),
          },
        },
      }
    }),

  updateSessionStatus: (status) =>
    set((state) => ({
      ...status,
      sessions: state.sessions.map((s) =>
        s.id === state.currentSessionId ? { ...s, ...status } : s,
      ),
    })),

  handleEvent: (sessionId, event) => {
    // ── Session-scoped status/meta: update the sessions list (and the active
    // scalars when it's the in-view session), regardless of which tab is open.
    if (event.type === 'agent.status.updated') {
      const ev = event as AgentStatusUpdatedEvent
      const patch: Partial<SessionInfo> = {}
      if (ev.model !== undefined) patch.model = ev.model
      if (ev.contextTokens !== undefined) patch.contextTokens = ev.contextTokens
      if (ev.maxContextTokens !== undefined) patch.maxContextTokens = ev.maxContextTokens
      if (ev.permission !== undefined) patch.permission = ev.permission
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.id === sessionId ? { ...sess, ...patch } : sess)),
        ...(s.currentSessionId === sessionId ? patch : {}),
      }))
      return
    }

    if (event.type === 'session.meta.updated') {
      const ev = event as SessionMetaUpdatedEvent
      if (ev.title) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, title: ev.title } : sess,
          ),
        }))
      }
      return
    }

    // ── Streaming content events: route to the in-view slice or the session's
    // background buffer so off-screen tasks keep building up their reply.
    const state = get()
    if (sessionId === state.currentSessionId) {
      const next = reduceMessageEvent(
        { messages: state.messages, isStreaming: state.isStreaming, streamStatus: state.streamStatus },
        event,
      )
      set({ messages: next.messages, isStreaming: next.isStreaming, streamStatus: next.streamStatus })
    } else {
      const prev = state.bg[sessionId] ?? EMPTY_BACKGROUND_SLICE
      const next = reduceMessageEvent(prev, event)
      if (next !== prev) {
        set({ bg: { ...state.bg, [sessionId]: { ...next, unread: true } } })
      }
    }
  },

  clearMessages: () => set({ messages: [] }),

  isSessionStreaming: (id) => {
    const s = get()
    if (id === s.currentSessionId) return s.isStreaming
    return s.bg[id]?.isStreaming ?? false
  },

  setThinkingPreference: async (level) => {
    setStoredThinking(level)
    const sessionId = get().currentSessionId
    set((state) => ({
      thinkingLevel: level,
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, thinkingLevel: level } : session,
      ),
    }))
    if (sessionId !== null) await window.lmcodeAPI.setThinking(sessionId, level)
  },

  applyThinkingPreference: async (sessionId) => {
    await window.lmcodeAPI.setThinking(sessionId, get().thinkingLevel)
  },

  hydrateThinkingPreference: () => {
    set({ thinkingLevel: getStoredThinking() })
  },

  enqueuePendingInteraction: (interaction) =>
    set((state) => {
      if (
        state.pendingInteractions.some(
          (pending) => pending.payload.requestId === interaction.payload.requestId,
        )
      ) {
        return state
      }
      return { pendingInteractions: [...state.pendingInteractions, interaction] }
    }),

  completePendingInteraction: (requestId) =>
    set((state) => {
      if (state.pendingInteractions[0]?.payload.requestId !== requestId) return state
      return { pendingInteractions: state.pendingInteractions.slice(1) }
    }),

  discardPendingInteraction: (requestId) =>
    set((state) => ({
      pendingInteractions: state.pendingInteractions.filter(
        (interaction) => interaction.payload.requestId !== requestId,
      ),
    })),

  enqueueMessage: (sessionId, text, attachments = []) => {
    queuedMessageCounter += 1
    const id = `queued_${Date.now()}_${queuedMessageCounter}`
    const message: QueuedUserMessage = {
      id,
      text,
      attachments: [...attachments],
      createdAt: Date.now(),
    }
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: [...(state.messageQueue[sessionId] ?? []), message],
      },
    }))
    return id
  },

  updateQueuedMessage: (sessionId, messageId, text) =>
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: (state.messageQueue[sessionId] ?? []).map((message) =>
          message.id === messageId ? { ...message, text } : message,
        ),
      },
    })),

  removeQueuedMessage: (sessionId, messageId) =>
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: (state.messageQueue[sessionId] ?? []).filter(
          (message) => message.id !== messageId,
        ),
      },
    })),

  moveQueuedMessage: (sessionId, messageId, direction) =>
    set((state) => {
      const queue = [...(state.messageQueue[sessionId] ?? [])]
      const index = queue.findIndex((message) => message.id === messageId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= queue.length) return state
      const current = queue[index]
      const adjacent = queue[target]
      if (!current || !adjacent) return state
      queue[index] = adjacent
      queue[target] = current
      return { messageQueue: { ...state.messageQueue, [sessionId]: queue } }
    }),

  shiftQueuedMessage: (sessionId) => {
    const queue = get().messageQueue[sessionId] ?? []
    const message = queue[0]
    if (!message) return undefined
    set((state) => ({
      messageQueue: {
        ...state.messageQueue,
        [sessionId]: (state.messageQueue[sessionId] ?? []).slice(1),
      },
    }))
    return message
  },
}))
