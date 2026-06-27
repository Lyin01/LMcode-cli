import { create } from 'zustand'
import type { Message, SessionInfo, ToolCallInfo } from '@/types'
import { getStoredThinking } from '@/lib/thinking'
import type {
  Event,
  TurnEndedEvent,
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolResultEvent,
  AgentStatusUpdatedEvent,
  SessionMetaUpdatedEvent,
  ErrorEvent,
  WarningEvent,
  TurnStepRetryingEvent,
  TurnStepInterruptedEvent,
} from '@lmcode-cli/lmcode-sdk'

let msgCounter = 0
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

    case 'tool.progress':
      return slice

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
  bg: Record<string, SessionSlice>

  model: string
  thinkingLevel: string
  permission: string
  contextTokens: number
  maxContextTokens: number

  pendingApproval: any | null
  pendingQuestion: any | null

  setSessions: (sessions: SessionInfo[]) => void
  selectSession: (id: string) => void
  createSession: () => Promise<void>
  addMessage: (msg: Message) => void
  setMessages: (msgs: Message[]) => void
  updateLastAssistantMessage: (updates: Partial<Message>) => void
  appendToLastMessage: (text: string) => void
  setStreaming: (val: boolean) => void
  setStreamStatus: (status: string | null) => void
  updateSessionStatus: (status: Partial<SessionInfo>) => void
  handleEvent: (sessionId: string, event: Event) => void
  clearMessages: () => void
  /** True if the given session is streaming, whether it's in view or backgrounded. */
  isSessionStreaming: (id: string) => boolean

  setPendingApproval: (req: any | null) => void
  setPendingQuestion: (req: any | null) => void
}

function createNewSession(sessionId: string, overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: sessionId,
    workDir: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    thinkingLevel: 'auto',
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
  thinkingLevel: 'auto',
  permission: 'manual',
  contextTokens: 0,
  maxContextTokens: 128000,

  pendingApproval: null,
  pendingQuestion: null,

  setSessions: (sessions) => set({ sessions }),

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
      thinkingLevel: session.thinkingLevel,
      permission: session.permission,
      contextTokens: session.contextTokens,
      maxContextTokens: session.maxContextTokens,
    })
  },

  createSession: async () => {
    try {
      const summary = await window.lmcodeAPI.createSession({
        workDir: '',
        thinking: getStoredThinking(),
      })
      const sid = summary?.id ?? `session_${Date.now()}`
      const newSession = createNewSession(sid, { title: summary?.title, workDir: summary?.workDir ?? '' })
      set((state) => {
        // Park the current session before switching so a task running there
        // survives (events keep flowing into bg) instead of being abandoned.
        const bg = { ...state.bg }
        if (state.currentSessionId) {
          bg[state.currentSessionId] = {
            messages: state.messages,
            isStreaming: state.isStreaming,
            streamStatus: state.streamStatus,
          }
        }
        return {
          bg,
          sessions: [...state.sessions, newSession],
          currentSessionId: sid,
          messages: [],
          isStreaming: false,
          streamStatus: null,
        }
      })
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  },

  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),

  setMessages: (msgs) => set({ messages: msgs }),

  updateLastAssistantMessage: (updates) =>
    set((state) => ({
      messages: patchLastAssistant(state.messages, (m) => ({ ...m, ...updates })),
    })),

  appendToLastMessage: (text) =>
    set((state) => ({
      messages: patchLastAssistant(state.messages, (m) => ({ ...m, content: m.content + text })),
    })),

  setStreaming: (val) => set({ isStreaming: val }),

  setStreamStatus: (status) => set({ streamStatus: status }),

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
      const prev = state.bg[sessionId] ?? EMPTY_SLICE
      const next = reduceMessageEvent(prev, event)
      if (next !== prev) set({ bg: { ...state.bg, [sessionId]: next } })
    }
  },

  clearMessages: () => set({ messages: [] }),

  isSessionStreaming: (id) => {
    const s = get()
    if (id === s.currentSessionId) return s.isStreaming
    return s.bg[id]?.isStreaming ?? false
  },

  setPendingApproval: (req) => set({ pendingApproval: req }),
  setPendingQuestion: (req) => set({ pendingQuestion: req }),
}))
