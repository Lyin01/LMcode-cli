import type { Event, GoalUpdatedEvent } from '@lmcode-cli/lmcode-sdk'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { SessionStore } from '@/stores/session-store'
import type { SubagentStore } from '@/stores/subagent-store'
import type { TaskStore } from '@/stores/task-store'
import type { InboxStore } from '@/stores/inbox-store'
import type { DesktopNotificationPayload } from '../../shared/ipc-types'

/**
 * Inbox 事件接线：把 session / subagent / task store 的状态变迁和 goal
 * 事件投影成 inbox 条目。与 React 解耦，便于直接驱动 store 做契约测试；
 * `useInbox` 只是把这层接线挂到真实 store 和 IPC 桥上。
 */

type SessionStoreApi = UseBoundStore<StoreApi<SessionStore>>
type SubagentStoreApi = UseBoundStore<StoreApi<SubagentStore>>
type TaskStoreApi = UseBoundStore<StoreApi<TaskStore>>
type InboxStoreApi = UseBoundStore<StoreApi<InboxStore>>

export interface InboxFeedDeps {
  readonly sessionStore: SessionStoreApi
  readonly subagentStore: SubagentStoreApi
  readonly taskStore: TaskStoreApi
  readonly inboxStore: InboxStoreApi
  /** 后台回合完成时的系统通知桥（main 进程决定窗口未聚焦时才真正弹出）。 */
  readonly notifyTurnCompleted?: (payload: DesktopNotificationPayload) => void
  /** 原始会话事件流（goal.updated 不进入任何 renderer store，只能在这里挂接）。 */
  readonly subscribeSessionEvents?: (
    callback: (payload: { sessionId: string; event: Event }) => void,
  ) => () => void
}

const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['running', 'awaiting_approval'])

function sessionTitle(state: SessionStore, sessionId: string): string {
  const title = state.sessions.find((session) => session.id === sessionId)?.title?.trim()
  return title || '新任务'
}

function sessionWorkDir(state: SessionStore, sessionId: string): string | undefined {
  return state.sessions.find((session) => session.id === sessionId)?.workDir || undefined
}

/** 每个会话（当前 + 后台）的 streaming 快照，用于检测 true → false 转换。 */
function streamingSnapshot(state: SessionStore): Map<string, boolean> {
  const snapshot = new Map<string, boolean>()
  if (state.currentSessionId !== null) {
    snapshot.set(state.currentSessionId, state.isStreaming)
  }
  for (const [sessionId, slice] of Object.entries(state.bg)) {
    snapshot.set(sessionId, slice.isStreaming)
  }
  return snapshot
}

function goalInboxEntry(
  event: GoalUpdatedEvent,
): { readonly title: string; readonly outcome: 'success' | 'failure' } | null {
  const change = event.change
  if (!change) return null
  if (change.kind === 'completion' || change.status === 'complete') {
    return { title: '目标已完成', outcome: 'success' }
  }
  if (change.status === 'blocked') {
    return { title: '目标被阻塞', outcome: 'failure' }
  }
  return null
}

/**
 * 启动接线，返回销毁函数。启动时先拍一份基线快照，只有之后发生的
 * 转换才会生成条目（恢复挂载不会把存量状态误判成新通知）。
 */
export function startInboxFeed(deps: InboxFeedDeps): () => void {
  const { sessionStore, subagentStore, taskStore, inboxStore } = deps

  let streaming = streamingSnapshot(sessionStore.getState())
  let currentSessionId = sessionStore.getState().currentSessionId
  let pendingApprovalIds = new Set(
    sessionStore
      .getState()
      .pendingInteractions.filter((interaction) => interaction.kind === 'approval')
      .map((interaction) => interaction.payload.requestId),
  )
  let subagentStatuses = new Map(
    subagentStore.getState().agents.map((agent) => [agent.subagentId, agent.status]),
  )
  let taskStatuses = new Map(
    taskStore.getState().tasks.map((task) => [task.taskId, task.status]),
  )

  const handleSessionState = (state: SessionStore): void => {
    // 查看会话后清除该会话的未读条目。
    if (state.currentSessionId !== currentSessionId) {
      currentSessionId = state.currentSessionId
      if (currentSessionId !== null) {
        inboxStore.getState().markSessionRead(currentSessionId)
      }
    }

    // 回合完成的收件箱投影：后台会话完成时进收件箱并通知；当前会话
    // 完成且窗口不可见（最小化/被遮挡）时只发桌面通知，不进收件箱。
    const nextStreaming = streamingSnapshot(state)
    const pageHidden =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
    for (const [sessionId, isStreaming] of nextStreaming) {
      if (streaming.get(sessionId) !== true || isStreaming) continue
      const isBackground = sessionId !== state.currentSessionId
      if (!isBackground && !pageHidden) continue
      const title = sessionTitle(state, sessionId)
      if (isBackground) {
        inboxStore.getState().add({
          type: 'turn-completed',
          sessionId,
          projectDir: sessionWorkDir(state, sessionId),
          title: `回合已完成：${title}`,
          outcome: 'success',
          mergeKey: `turn-completed:${sessionId}`,
        })
        deps.notifyTurnCompleted?.({
          kind: 'turn-completed',
          sessionId,
          title,
          body: '后台任务的回合已完成',
        })
      } else {
        deps.notifyTurnCompleted?.({
          kind: 'turn-completed',
          sessionId,
          title,
          body: '当前任务已完成',
        })
      }
    }
    streaming = nextStreaming

    // 审批：新出现的请求生成条目（按 requestId 去重）；从队列消失
    // （已解决或被丢弃）的请求自动标记已读。
    const nextApprovalIds = new Set(
      state.pendingInteractions
        .filter((interaction) => interaction.kind === 'approval')
        .map((interaction) => interaction.payload.requestId),
    )
    for (const interaction of state.pendingInteractions) {
      if (interaction.kind !== 'approval') continue
      const { requestId, sessionId, request } = interaction.payload
      if (pendingApprovalIds.has(requestId)) continue
      inboxStore.getState().add({
        id: `approval-pending:${requestId}`,
        type: 'approval-pending',
        sessionId,
        projectDir: sessionWorkDir(state, sessionId),
        title: `等待审批：${request.toolName ?? request.action ?? '执行操作'}`,
        body: request.action || undefined,
        outcome: 'info',
      })
    }
    for (const requestId of pendingApprovalIds) {
      if (!nextApprovalIds.has(requestId)) {
        inboxStore.getState().markRead(`approval-pending:${requestId}`)
      }
    }
    pendingApprovalIds = nextApprovalIds
  }

  const handleSubagentState = (state: SubagentStore): void => {
    const nextStatuses = new Map(state.agents.map((agent) => [agent.subagentId, agent.status]))
    for (const agent of state.agents) {
      if (agent.status === 'running') continue
      const previous = subagentStatuses.get(agent.subagentId)
      if (previous !== undefined && previous !== 'running') continue
      const sessionState = sessionStore.getState()
      inboxStore.getState().add({
        type: 'subagent-finished',
        sessionId: agent.sessionId,
        projectDir: sessionWorkDir(sessionState, agent.sessionId),
        title:
          agent.status === 'completed'
            ? `子代理 ${agent.name} 已完成`
            : `子代理 ${agent.name} 失败`,
        body: agent.resultSummary ?? agent.error,
        outcome: agent.status === 'completed' ? 'success' : 'failure',
        mergeKey: `subagent-finished:${agent.subagentId}`,
      })
    }
    subagentStatuses = nextStatuses
  }

  const handleTaskState = (state: TaskStore): void => {
    const nextStatuses = new Map(state.tasks.map((task) => [task.taskId, task.status]))
    for (const task of state.tasks) {
      if (ACTIVE_TASK_STATUSES.has(task.status)) continue
      const previous = taskStatuses.get(task.taskId)
      if (previous === undefined || !ACTIVE_TASK_STATUSES.has(previous)) continue
      const succeeded = task.status === 'completed' && task.exitCode === 0
      const label =
        task.status === 'completed'
          ? '已完成'
          : task.status === 'failed'
            ? '失败'
            : task.status === 'killed'
              ? '已终止'
              : '丢失'
      const sessionState = sessionStore.getState()
      inboxStore.getState().add({
        type: 'task-finished',
        sessionId: task.sessionId,
        projectDir: sessionWorkDir(sessionState, task.sessionId),
        title: `后台任务${label}：${task.description || task.command}`,
        body: task.exitCode !== null ? `退出码：${task.exitCode}` : task.stopReason,
        outcome: succeeded ? 'success' : 'failure',
        mergeKey: `task-finished:${task.taskId}`,
      })
    }
    taskStatuses = nextStatuses
  }

  const unsubscribers = [
    sessionStore.subscribe(handleSessionState),
    subagentStore.subscribe(handleSubagentState),
    taskStore.subscribe(handleTaskState),
  ]

  if (deps.subscribeSessionEvents) {
    unsubscribers.push(
      deps.subscribeSessionEvents(({ sessionId, event }) => {
        if (event.type !== 'goal.updated') return
        const entry = goalInboxEntry(event)
        if (!entry) return
        const sessionState = sessionStore.getState()
        inboxStore.getState().add({
          type: 'goal-update',
          sessionId,
          projectDir: sessionWorkDir(sessionState, sessionId),
          title: `${entry.title}：${sessionTitle(sessionState, sessionId)}`,
          body: event.change?.reason,
          outcome: entry.outcome,
          mergeKey: `goal-update:${sessionId}:${entry.outcome}`,
        })
      }),
    )
  }

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
