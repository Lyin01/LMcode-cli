import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'
import { useTaskStore } from '../src/renderer/stores/task-store'
import { useSubagentStore } from '../src/renderer/stores/subagent-store'
import { getComposerDraft, saveComposerDraft } from '../src/renderer/lib/composer-drafts'
import type { SessionInfo } from '../src/renderer/types'

function session(id: string): SessionInfo {
  return {
    id,
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

function makeTask(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'task-1',
    command: 'pnpm test',
    description: 'run tests',
    status: 'running',
    pid: 1234,
    exitCode: null,
    startedAt: 1000,
    endedAt: null,
    ...overrides,
  }
}

describe('desktop session deletion store cleanup', () => {
  beforeEach(() => {
    useTaskStore.setState({ tasks: [] })
    useSubagentStore.setState({ agents: [] })
    useSessionStore.setState({
      currentSessionId: 'session-a',
      sessions: [session('session-a'), session('session-b')],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
      messageQueue: {},
    })
  })

  it('drops background tasks and subagent records belonging to the deleted session', () => {
    useTaskStore.getState().addOrUpdateTask('session-a', makeTask({ taskId: 'task-a' }))
    useTaskStore.getState().addOrUpdateTask('session-b', makeTask({ taskId: 'task-b' }))
    useSubagentStore.getState().spawned('session-a', {
      type: 'subagent.spawned',
      subagentId: 'agent-a',
      subagentName: 'Agent A',
      parentToolCallId: 'tc-a',
      runInBackground: true,
    })
    useSubagentStore.getState().spawned('session-b', {
      type: 'subagent.spawned',
      subagentId: 'agent-b',
      subagentName: 'Agent B',
      parentToolCallId: 'tc-b',
      runInBackground: true,
    })

    useSessionStore.getState().removeDeletedSession('session-a', [session('session-b')])

    expect(useTaskStore.getState().tasks.map((task) => task.taskId)).toEqual(['task-b'])
    expect(useSubagentStore.getState().agents.map((agent) => agent.subagentId)).toEqual([
      'agent-b',
    ])
  })

  it('clears the deleted session\'s composer draft', () => {
    saveComposerDraft('session-a', '未发送的草稿')
    saveComposerDraft('session-b', '其他会话的草稿')

    useSessionStore.getState().removeDeletedSession('session-a', [session('session-b')])

    expect(getComposerDraft('session-a')).toBe('')
    expect(getComposerDraft('session-b')).toBe('其他会话的草稿')
  })
})
