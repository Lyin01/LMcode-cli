import { create } from 'zustand'
import type {
  Message,
  PendingInteraction,
  QueuedUserMessage,
  SessionInfo,
  TokenUsageSummary,
  ToolCallInfo,
  UserAttachment,
} from '@/types'
import { summarizeUsage } from '@/lib/usage'
import {
  DEFAULT_THINKING_EFFORT,
  getStoredThinking,
  setStoredThinking,
  type ThinkingEffort,
} from '@/lib/thinking'
import {
  getStoredPermissionPreference,
  setStoredPermissionPreference,
} from '@/lib/permission-preference'
import { buildModelEntries } from '@/lib/models'
import { createDesktopPromptRequest } from '@/lib/prompt-request'
import { clearComposerDraft } from '@/lib/composer-drafts'
import { useConfigStore } from '@/stores/config-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { useGoalStore } from '@/stores/goal-store'
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
  PermissionMode,
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

/**
 * Transcript-class event types: they feed a session's message stream or its
 * streaming flags, and only the session's main agent may do that. Sub-agents
 * share the session's event stream — their events carry their own agentId —
 * so without this filter a sub-agent's turn would open empty bubbles, patch
 * the main agent's reply, flip `isStreaming` (unlocking the composer), or
 * surface its failure as a parent-session error card.
 *
 * Session-level events (agent.status.updated, session.meta.updated,
 * subagent.*, background.task.*, mcp.server.status, compaction.*, …) are NOT
 * listed here: they always pass through to their stores.
 */
const TRANSCRIPT_EVENT_TYPES: ReadonlySet<Event['type']> = new Set([
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'assistant.delta',
  'thinking.delta',
  'hook.result',
  'tool.call.started',
  'tool.call.delta',
  'tool.result',
  'tool.progress',
  'error',
  'warning',
])

const EMPTY_SLICE: SessionSlice = { messages: [], isStreaming: false, streamStatus: null }

interface BackgroundSessionSlice extends SessionSlice {
  readonly unread: boolean
}

const EMPTY_BACKGROUND_SLICE: BackgroundSessionSlice = {
  ...EMPTY_SLICE,
  unread: false,
}

/** Strip an attachment down to what the chat UI needs to render its card. */
export function toDisplayAttachment(attachment: UserAttachment): UserAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    truncated: attachment.truncated,
    previewUrl: attachment.previewUrl,
  }
}

/**
 * Merge a fresh `listSessions` snapshot with the runtime metadata the store
 * already accumulated (model, permission, token counters, streaming flag).
 * A naive remap would reset every surviving session to `manual`/0/not
 * streaming until the next status event trickles in.
 */
export function mergeRefreshedSessions(
  raw: readonly SessionSummary[],
  existing: readonly SessionInfo[],
  thinkingLevel: ThinkingEffort,
): SessionInfo[] {
  const byId = new Map(existing.map((session) => [session.id, session]))
  return raw.map((summary) => {
    const prior = byId.get(summary.id)
    return {
      id: summary.id,
      title: summary.title,
      workDir: summary.workDir,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      lastPrompt: summary.lastPrompt,
      model: prior?.model,
      thinkingLevel: prior?.thinkingLevel ?? thinkingLevel,
      permission: prior?.permission ?? 'manual',
      contextTokens: prior?.contextTokens ?? 0,
      maxContextTokens: prior?.maxContextTokens ?? 128_000,
      isStreaming: prior?.isStreaming ?? false,
    }
  })
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
        startedAt: Date.now(),
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
                        endedAt: Date.now(),
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

/**
 * Where a brand-new session should live when the welcome screen submits its
 * first message: an explicit project directory, or the main-process
 * no-project sentinel workspace.
 */
export type NewSessionTarget =
  | { readonly kind: 'project'; readonly workDir: string }
  | { readonly kind: 'no-project' }

export interface SessionStore {
  currentSessionId: string | null
  sessions: SessionInfo[]
  /**
   * Main-process sentinel directory backing "不在项目中工作" sessions. Loaded
   * once at startup via IPC; null until then (nothing is treated as sentinel).
   */
  noProjectWorkDir: string | null
  // ── Active (in-view) session slice ──
  messages: Message[]
  isStreaming: boolean
  /** Transient status line shown while streaming (e.g. retry / interrupt notices). */
  streamStatus: string | null
  /** Parked slices for sessions that are not in view but may still be streaming. */
  bg: Record<string, BackgroundSessionSlice>

  model: string
  thinkingLevel: ThinkingEffort
  /** Persisted app-wide default; also applied to the active session when changed. */
  permissionPreference: PermissionMode
  /** Permission mode currently reported for the active session. */
  permission: PermissionMode
  contextTokens: number
  maxContextTokens: number
  usage: TokenUsageSummary | undefined

  pendingInteractions: PendingInteraction[]
  messageQueue: Record<string, QueuedUserMessage[]>
  /**
   * Sessions whose on-disk history has already been merged into the live
   * view. Guards the backfill so a slow `getSessionHistory` can't be dropped
   * just because the user typed first, and can't be applied twice.
   */
  hydratedSessions: Record<string, boolean>

  setSessions: (sessions: SessionInfo[]) => void
  setNoProjectWorkDir: (workDir: string) => void
  removeDeletedSession: (deletedId: string, remaining: SessionInfo[]) => void
  selectSession: (id: string) => void
  /**
   * Leave the current session and return to the welcome screen. The session
   * keeps living (and streaming) in the background slice, exactly as if the
   * user had switched to another session.
   */
  clearCurrentSession: () => void
  createSession: (workDir?: string, options?: { noProject?: boolean }) => Promise<void>
  /**
   * Welcome-screen entry point: create a session for the chosen target, then
   * queue the first message. The message rides the normal send pipeline — the
   * composer's queue drain in `useSession` ships it as soon as the new session
   * mounts, so creation always settles before anything is sent.
   */
  startSessionWithMessage: (
    target: NewSessionTarget,
    text: string,
    attachments?: readonly UserAttachment[],
  ) => Promise<void>
  adoptSession: (summary: SessionSummary) => void
  addMessage: (msg: Message) => void
  addMessageToSession: (
    sessionId: string,
    msg: Message,
    options?: { markUnread?: boolean },
  ) => void
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
  setPermissionPreference: (permission: PermissionMode) => Promise<void>
  applyPermissionPreference: (sessionId: string) => Promise<void>

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
  /**
   * Single-owner queue drain: sends the oldest queued message for a session
   * once that session is idle, then re-schedules itself when the turn ends.
   * Works for background sessions too, and is reentrant-safe across any
   * number of mounted hooks.
   */
  drainMessageQueue: (sessionId: string) => void
  /**
   * Merge a session's persisted history ahead of whatever live messages
   * already accumulated (in view or in its background slice). No-ops for
   * sessions that were already hydrated.
   */
  hydrateSessionHistory: (sessionId: string, history: Message[]) => void
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
    usage: undefined,
    isStreaming: false,
    ...overrides,
  }
}

/**
 * Sessions with a queued send currently in flight. Lives outside the store
 * state: it guards against reentrant drains within the same tick, so it must
 * not wait for a React commit (or a second hook instance) to take effect.
 */
const queueDrainInFlight = new Set<string>()

/**
 * Single-flight latch for `startSessionWithMessage`. Module-level (like
 * `queueDrainInFlight`) so it takes effect synchronously, before any React
 * commit or IPC await can interleave a second call.
 */
let startSessionInFlight = false

const initialPermissionPreference = getStoredPermissionPreference()

export const useSessionStore = create<SessionStore>((set, get) => ({
  currentSessionId: null,
  sessions: [],
  noProjectWorkDir: null,
  messages: [],
  isStreaming: false,
  streamStatus: null,
  bg: {},

  model: '',
  thinkingLevel: DEFAULT_THINKING_EFFORT,
  permissionPreference: initialPermissionPreference,
  permission: initialPermissionPreference,
  contextTokens: 0,
  maxContextTokens: 128000,
  usage: undefined,

  pendingInteractions: [],
  messageQueue: {},
  hydratedSessions: {},

  setSessions: (sessions) => set({ sessions }),

  setNoProjectWorkDir: (workDir) => set({ noProjectWorkDir: workDir }),

  removeDeletedSession: (deletedId, remaining) => {
    set((state) => {
      const bg = { ...state.bg }
      const messageQueue = { ...state.messageQueue }
      const hydratedSessions = { ...state.hydratedSessions }
      const pendingInteractions = state.pendingInteractions.filter(
        (interaction) => interaction.payload.sessionId !== deletedId,
      )
      delete bg[deletedId]
      delete messageQueue[deletedId]
      delete hydratedSessions[deletedId]

      if (state.currentSessionId !== deletedId) {
        return { sessions: remaining, bg, messageQueue, hydratedSessions, pendingInteractions }
      }

      const next = remaining[0]
      if (!next) {
        return {
          sessions: remaining,
          bg,
          messageQueue,
          hydratedSessions,
          pendingInteractions,
          currentSessionId: null,
          messages: [],
          isStreaming: false,
          streamStatus: null,
          model: '',
          permission: state.permissionPreference,
          contextTokens: 0,
          maxContextTokens: 128000,
          usage: undefined,
        }
      }

      const restored = bg[next.id]
      delete bg[next.id]
      return {
        sessions: remaining,
        bg,
        messageQueue,
        hydratedSessions,
        pendingInteractions,
        currentSessionId: next.id,
        messages: restored?.messages ?? [],
        isStreaming: restored?.isStreaming ?? false,
        streamStatus: restored?.streamStatus ?? null,
        model: next.model ?? '',
        permission: next.permission,
        contextTokens: next.contextTokens,
        maxContextTokens: next.maxContextTokens,
        usage: next.usage,
      }
    })
    // The deleted session's background tasks and subagents die with it;
    // drop their records so the panels don't keep showing zombies. Its
    // unsent composer draft goes too — otherwise it would linger in memory
    // for the rest of the renderer's lifetime.
    useTaskStore.getState().removeBySession(deletedId)
    useSubagentStore.getState().removeBySession(deletedId)
    useGoalStore.getState().removeBySession(deletedId)
    clearComposerDraft(deletedId)
  },

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
      usage: session.usage,
    })
  },

  clearCurrentSession: () => {
    const state = get()
    if (state.currentSessionId === null) return
    // Park the session we're leaving so its in-flight stream keeps
    // accumulating and is restored intact when the user comes back.
    const bg = { ...state.bg }
    bg[state.currentSessionId] = {
      messages: state.messages,
      isStreaming: state.isStreaming,
      streamStatus: state.streamStatus,
      unread: false,
    }
    set({
      bg,
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      streamStatus: null,
      model: '',
      permission: state.permissionPreference,
      contextTokens: 0,
      maxContextTokens: 128000,
    })
  },

  createSession: async (requestedWorkDir, options) => {
    try {
      const noProject = options?.noProject === true
      let workDir = requestedWorkDir?.trim()
      if (!noProject && !workDir) {
        const current = get().sessions.find((session) => session.id === get().currentSessionId)
        workDir = await window.lmcodeAPI.selectWorkDirectory(current?.workDir)
      }
      if (!noProject && !workDir) return

      const state = get()
      // A fresh session inherits the model of whatever session was current,
      // which is '' on the welcome screen. Fall back to the configured
      // default model, then to any configured model, so a new conversation
      // never starts without a model and fails its first turn.
      const config = useConfigStore.getState().config
      const fallbackModel = config
        ? config.defaultModel?.trim() || buildModelEntries(config)[0]?.id || ''
        : ''
      const model = state.model.trim() || fallbackModel
      const permission = state.permissionPreference
      const summary = await window.lmcodeAPI.createSession({
        // The main process resolves the no-project sentinel directory itself;
        // the renderer never supplies a path for it.
        workDir: noProject ? undefined : workDir,
        noProject: noProject || undefined,
        model: model || undefined,
        thinking: state.thinkingLevel,
        permission,
      })
      get().adoptSession(summary)
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  },

  startSessionWithMessage: async (target, text, attachments = []) => {
    // Store-level single-flight: the welcome screen also guards with its own
    // `starting` state, but a future caller without it must not be able to
    // race creation into two sessions.
    if (startSessionInFlight) {
      console.warn('startSessionWithMessage already in flight; ignoring concurrent call')
      return
    }
    startSessionInFlight = true
    try {
      if (target.kind === 'no-project') {
        await get().createSession(undefined, { noProject: true })
      } else {
        await get().createSession(target.workDir)
      }
      const sessionId = get().currentSessionId
      if (sessionId === null) return
      const normalized = text.trim()
      if (!normalized && attachments.length === 0) return
      // The message rides the normal send pipeline: enqueueing triggers the
      // store-level queue drain, which ships it as soon as the (idle) session
      // is ready — creation always settles before anything is sent.
      get().enqueueMessage(sessionId, normalized, attachments)
    } finally {
      startSessionInFlight = false
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
      permission: state.permissionPreference,
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
        // A freshly adopted session has no on-disk history to backfill;
        // marking it hydrated keeps the backfill from duplicating its
        // first turn once that turn is persisted.
        hydratedSessions: { ...current.hydratedSessions, [summary.id]: true },
        currentSessionId: summary.id,
        messages: [],
        isStreaming: false,
        streamStatus: null,
        model: newSession.model ?? '',
        permission: newSession.permission,
        contextTokens: newSession.contextTokens,
        maxContextTokens: newSession.maxContextTokens,
        usage: newSession.usage,
      }
    })
  },

  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),

  addMessageToSession: (sessionId, msg, options) =>
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
            unread: options?.markUnread ?? true,
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
    // Sub-agents emit into the same session stream under their own agentId
    // ('main' is the primary agent). Drop their transcript-class traffic so
    // it can't pollute the parent's message flow; session-level events still
    // pass through, and events without an agentId (older main processes) are
    // treated as main for backward compatibility.
    if (
      event.agentId !== undefined &&
      event.agentId !== 'main' &&
      TRANSCRIPT_EVENT_TYPES.has(event.type)
    ) {
      return
    }

    // Activity drives sidebar ordering. Keep it live instead of waiting for a
    // full listSessions refresh, which may not happen again until restart.
    if (event.type === 'turn.started' || event.type === 'turn.ended') {
      const isStreaming = event.type === 'turn.started'
      const updatedAt = Date.now()
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? { ...session, updatedAt, isStreaming } : session,
        ),
      }))
    }

    // ── Session-scoped status/meta: update the sessions list (and the active
    // scalars when it's the in-view session), regardless of which tab is open.
    if (event.type === 'agent.status.updated') {
      const ev = event as AgentStatusUpdatedEvent
      const patch: Partial<SessionInfo> = {}
      if (ev.model !== undefined) patch.model = ev.model
      if (ev.contextTokens !== undefined) patch.contextTokens = ev.contextTokens
      if (ev.maxContextTokens !== undefined) patch.maxContextTokens = ev.maxContextTokens
      if (ev.usage !== undefined) patch.usage = summarizeUsage(ev.usage)
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
      // Tail events of a deleted (or otherwise unknown) session must not
      // resurrect it as an invisible background buffer.
      if (!state.sessions.some((session) => session.id === sessionId)) return
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
    const sessionId = get().currentSessionId
    if (sessionId !== null) await window.lmcodeAPI.setThinking(sessionId, level)

    setStoredThinking(level)
    set((state) => ({
      thinkingLevel: level,
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, thinkingLevel: level } : session,
      ),
    }))
  },

  applyThinkingPreference: async (sessionId) => {
    await window.lmcodeAPI.setThinking(sessionId, get().thinkingLevel)
  },

  hydrateThinkingPreference: () => {
    set({ thinkingLevel: getStoredThinking() })
  },

  setPermissionPreference: async (permission) => {
    const sessionId = get().currentSessionId
    if (sessionId !== null) await window.lmcodeAPI.setPermission(sessionId, permission)

    setStoredPermissionPreference(permission)
    set((state) => ({
      permissionPreference: permission,
      ...(state.currentSessionId === sessionId ? { permission } : {}),
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, permission } : session,
      ),
    }))
  },

  applyPermissionPreference: async (sessionId) => {
    const permission = get().permissionPreference
    await window.lmcodeAPI.setPermission(sessionId, permission)
    set((state) => ({
      ...(state.currentSessionId === sessionId ? { permission } : {}),
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, permission } : session,
      ),
    }))
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

  drainMessageQueue: (sessionId) => {
    const state = get()
    if (queueDrainInFlight.has(sessionId)) return
    if (!state.sessions.some((session) => session.id === sessionId)) return
    if (state.isSessionStreaming(sessionId)) return
    if ((state.messageQueue[sessionId]?.length ?? 0) === 0) return

    queueDrainInFlight.add(sessionId)
    // Skip entries that carry no content at all.
    let next = get().shiftQueuedMessage(sessionId)
    while (next && !next.text.trim() && next.attachments.length === 0) {
      next = get().shiftQueuedMessage(sessionId)
    }
    if (!next) {
      queueDrainInFlight.delete(sessionId)
      return
    }
    void deliverQueuedMessage(sessionId, next.text, next.attachments).finally(() => {
      queueDrainInFlight.delete(sessionId)
      // The turn this send kicked off ends later (turn.ended flips
      // isStreaming, which re-triggers the drain via the subscription
      // below). Kick once more here in case it ended before we unparked.
      scheduleQueueDrain()
    })
  },

  hydrateSessionHistory: (sessionId, history) =>
    set((state) => {
      // A backfill for a session deleted while getSessionHistory was in
      // flight must not resurrect a ghost background slice or re-mark it
      // hydrated — removeDeletedSession just cleaned both up. Same guard as
      // the streaming-event path in handleEvent.
      if (!state.sessions.some((session) => session.id === sessionId)) return state
      if (state.hydratedSessions[sessionId]) return state
      const hydratedSessions = { ...state.hydratedSessions, [sessionId]: true }
      if (history.length === 0) return { hydratedSessions }
      // Prepend: anything already in the slice arrived live (typed or
      // streamed) after the history snapshot was taken on disk.
      if (state.currentSessionId === sessionId) {
        return { hydratedSessions, messages: [...history, ...state.messages] }
      }
      const previous = state.bg[sessionId] ?? EMPTY_BACKGROUND_SLICE
      return {
        hydratedSessions,
        bg: {
          ...state.bg,
          [sessionId]: { ...previous, messages: [...history, ...previous.messages] },
        },
      }
    }),
}))

/** Send one queued message through the same pipeline the composer uses. */
async function deliverQueuedMessage(
  sessionId: string,
  text: string,
  attachments: readonly UserAttachment[],
): Promise<void> {
  const store = useSessionStore.getState()
  store.addMessageToSession(
    sessionId,
    {
      id: nextMsgId(),
      role: 'user',
      content: text,
      attachments: attachments.map(toDisplayAttachment),
      timestamp: Date.now(),
    },
    // The user sent this message themselves — a background session must not
    // raise its unread badge for it. The assistant's reply (via handleEvent)
    // still marks the session unread.
    { markUnread: false },
  )
  store.setSessionStreaming(sessionId, true)
  try {
    await window.lmcodeAPI.sendMessage(
      sessionId,
      createDesktopPromptRequest(text, attachments),
    )
  } catch (err) {
    console.error('Failed to send queued message:', err)
    const message = err instanceof Error ? err.message : String(err)
    const current = useSessionStore.getState()
    current.addMessageToSession(sessionId, {
      id: nextMsgId(),
      role: 'system',
      variant: 'error',
      content: `发送失败：${message}`,
      timestamp: Date.now(),
    })
    current.setSessionStreaming(sessionId, false)
  }
}

/**
 * Re-evaluate every session's queue on the next microtask. Deferred so the
 * store subscription never runs drains reentrantly inside a `set`.
 */
function scheduleQueueDrain(): void {
  queueMicrotask(() => {
    const state = useSessionStore.getState()
    for (const sessionId of Object.keys(state.messageQueue)) {
      if ((state.messageQueue[sessionId]?.length ?? 0) > 0) {
        state.drainMessageQueue(sessionId)
      }
    }
  })
}

// The queue drain has exactly one owner — the store itself. Any state change
// (enqueue, turn.ended flipping a session idle, cancel, deletion) gives every
// session's queue a chance to advance, in view or in the background.
useSessionStore.subscribe(() => {
  scheduleQueueDrain()
})
