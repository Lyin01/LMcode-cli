import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@lmcode-cli/lmcode-sdk'
import type { PendingInteraction } from '../src/shared/ipc-types'
import { startInboxFeed } from '../src/renderer/lib/inbox-feed'
import { useInboxStore } from '../src/renderer/stores/inbox-store'
import { useSessionStore } from '../src/renderer/stores/session-store'
import { useSubagentStore } from '../src/renderer/stores/subagent-store'
import { useTaskStore } from '../src/renderer/stores/task-store'
import type { SessionInfo } from '../src/renderer/types'

function sessionFixture(id: string, title: string): SessionInfo {
  return {
    id,
    title,
    workDir: `C:/repo-${id}`,
    createdAt: 1,
    updatedAt: 1,
    thinkingLevel: 'medium',
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 1_000,
    isStreaming: false,
  }
}

function turnEvent(type: 'turn.started' | 'turn.ended', sessionId: string): Event {
  return {
    type,
    turnId: 1,
    ...(type === 'turn.started' ? { origin: { kind: 'user' as const } } : { reason: 'completed' as const }),
    agentId: 'main',
    sessionId,
  } as Event
}

const approvalInteraction: PendingInteraction = {
  kind: 'approval',
  payload: {
    sessionId: 'session-b',
    requestId: 'approval-1',
    request: {
      toolCallId: 'tool-1',
      toolName: 'Shell',
      action: 'Run command',
      display: { kind: 'generic', summary: 'Run command' },
    },
  },
}

describe('desktop inbox feed wiring', () => {
  let dispose: (() => void) | undefined
  let emitSessionEvent: ((payload: { sessionId: string; event: Event }) => void) | undefined
  const notifyTurnCompleted = vi.fn()

  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: 'session-a',
      sessions: [sessionFixture('session-a', '当前任务'), sessionFixture('session-b', '后台任务')],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
      pendingInteractions: [],
    })
    useSubagentStore.setState({ agents: [] })
    useTaskStore.setState({ tasks: [] })
    useInboxStore.setState({ items: [] })
    notifyTurnCompleted.mockClear()

    dispose = startInboxFeed({
      sessionStore: useSessionStore,
      subagentStore: useSubagentStore,
      taskStore: useTaskStore,
      inboxStore: useInboxStore,
      notifyTurnCompleted,
      subscribeSessionEvents: (callback) => {
        emitSessionEvent = callback
        return () => {
          emitSessionEvent = undefined
        }
      },
    })
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('creates a turn-completed entry (and a system notification) only for background sessions', () => {
    const store = useSessionStore.getState()
    // Background session runs a full turn off-screen.
    store.handleEvent('session-b', turnEvent('turn.started', 'session-b'))
    store.handleEvent('session-b', turnEvent('turn.ended', 'session-b'))
    // The in-view session also finishes a turn: the user is looking at it.
    store.handleEvent('session-a', turnEvent('turn.started', 'session-a'))
    store.handleEvent('session-a', turnEvent('turn.ended', 'session-a'))

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: 'turn-completed',
      sessionId: 'session-b',
      read: false,
      outcome: 'success',
    })
    expect(items[0]?.title).toContain('后台任务')
    expect(notifyTurnCompleted).toHaveBeenCalledTimes(1)
    expect(notifyTurnCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'turn-completed', sessionId: 'session-b', title: '后台任务' }),
    )
  })

  it('collapses consecutive completions of the same background session into one unread entry', () => {
    const store = useSessionStore.getState()
    for (let turn = 0; turn < 3; turn += 1) {
      store.handleEvent('session-b', turnEvent('turn.started', 'session-b'))
      store.handleEvent('session-b', turnEvent('turn.ended', 'session-b'))
    }

    expect(
      useInboxStore.getState().items.filter((item) => item.type === 'turn-completed'),
    ).toHaveLength(1)
  })

  it('marks a session’s entries read when the user switches to it', () => {
    const store = useSessionStore.getState()
    store.handleEvent('session-b', turnEvent('turn.started', 'session-b'))
    store.handleEvent('session-b', turnEvent('turn.ended', 'session-b'))
    expect(useInboxStore.getState().items[0]?.read).toBe(false)

    store.selectSession('session-b')

    expect(useInboxStore.getState().items.every((item) => item.read)).toBe(true)
  })

  it('tracks approval requests and marks them read once settled', () => {
    const store = useSessionStore.getState()
    store.enqueuePendingInteraction(approvalInteraction)

    const pending = useInboxStore.getState().items
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      type: 'approval-pending',
      sessionId: 'session-b',
      read: false,
    })
    expect(pending[0]?.title).toContain('Shell')

    store.completePendingInteraction('approval-1')

    expect(useInboxStore.getState().items[0]?.read).toBe(true)
  })

  it('reports subagent terminal states with a success/failure outcome', () => {
    const subagents = useSubagentStore.getState()
    subagents.spawned('session-b', {
      type: 'subagent.spawned',
      subagentId: 'agent-ok',
      subagentName: 'explorer',
      parentToolCallId: 'tool-1',
      runInBackground: true,
    })
    subagents.spawned('session-b', {
      type: 'subagent.spawned',
      subagentId: 'agent-bad',
      subagentName: 'worker',
      parentToolCallId: 'tool-2',
      runInBackground: true,
    })
    subagents.completed('session-b', {
      type: 'subagent.completed',
      subagentId: 'agent-ok',
      parentToolCallId: 'tool-1',
      resultSummary: 'done',
    })
    subagents.failed('session-b', {
      type: 'subagent.failed',
      subagentId: 'agent-bad',
      parentToolCallId: 'tool-2',
      error: 'boom',
    })

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.title.includes('explorer'))).toMatchObject({
      type: 'subagent-finished',
      outcome: 'success',
    })
    expect(items.find((item) => item.title.includes('worker'))).toMatchObject({
      type: 'subagent-finished',
      outcome: 'failure',
    })
  })

  it('reports background task exits, deriving the outcome from the exit code', () => {
    const tasks = useTaskStore.getState()
    const runningTask = {
      taskId: 'task-1',
      command: 'npm test',
      description: 'Run tests',
      status: 'running' as const,
      pid: 123,
      exitCode: null,
      startedAt: 1,
      endedAt: null,
    }
    tasks.addOrUpdateTask('session-b', runningTask)
    tasks.addOrUpdateTask('session-b', {
      ...runningTask,
      status: 'completed',
      exitCode: 0,
      endedAt: 2,
    })
    tasks.addOrUpdateTask('session-b', {
      ...runningTask,
      taskId: 'task-2',
      status: 'running',
    })
    tasks.addOrUpdateTask('session-b', {
      ...runningTask,
      taskId: 'task-2',
      status: 'failed',
      exitCode: 1,
      endedAt: 3,
    })

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.body === '退出码：0')).toMatchObject({
      type: 'task-finished',
      outcome: 'success',
    })
    expect(items.find((item) => item.body === '退出码：1')).toMatchObject({
      type: 'task-finished',
      outcome: 'failure',
    })
  })

  it('surfaces goal completion and blockage from the session event stream', () => {
    emitSessionEvent?.({
      sessionId: 'session-b',
      event: {
        type: 'goal.updated',
        snapshot: null,
        change: { kind: 'completion', status: 'complete' },
      } as Event,
    })
    emitSessionEvent?.({
      sessionId: 'session-b',
      event: {
        type: 'goal.updated',
        snapshot: null,
        change: { kind: 'lifecycle', status: 'blocked', reason: '超出轮次预算' },
      } as Event,
    })
    // 没有 change 的周期性更新不产生条目。
    emitSessionEvent?.({
      sessionId: 'session-b',
      event: { type: 'goal.updated', snapshot: null } as Event,
    })

    const items = useInboxStore.getState().items
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.outcome === 'success')).toMatchObject({
      type: 'goal-update',
      sessionId: 'session-b',
    })
    expect(items.find((item) => item.outcome === 'failure')).toMatchObject({
      type: 'goal-update',
      body: '超出轮次预算',
    })
  })

  it('does not replay pre-existing state as fresh entries on startup', () => {
    dispose?.()
    useInboxStore.setState({ items: [] })
    // A task that already finished before the feed started must not reappear.
    useTaskStore.setState({
      tasks: [
        {
          taskId: 'task-old',
          sessionId: 'session-b',
          command: 'npm build',
          description: 'Build',
          status: 'completed',
          pid: 1,
          exitCode: 0,
          startedAt: 1,
          endedAt: 2,
        },
      ],
    })

    dispose = startInboxFeed({
      sessionStore: useSessionStore,
      subagentStore: useSubagentStore,
      taskStore: useTaskStore,
      inboxStore: useInboxStore,
    })

    expect(useInboxStore.getState().items).toEqual([])
  })
})
