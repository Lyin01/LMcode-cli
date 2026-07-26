import { beforeEach, describe, expect, it } from 'vitest'
import { useSubagentStore } from '../src/renderer/stores/subagent-store'

describe('desktop subagent lifecycle', () => {
  beforeEach(() => {
    useSubagentStore.setState({ agents: [] })
  })

  it('projects spawned and completed events into a session-scoped result', () => {
    const store = useSubagentStore.getState()
    store.spawned('session-a', {
      type: 'subagent.spawned',
      subagentId: 'agent-1',
      subagentName: 'explorer',
      parentToolCallId: 'tool-1',
      description: 'Inspect the renderer event flow',
      runInBackground: true,
    })
    store.completed('session-a', {
      type: 'subagent.completed',
      subagentId: 'agent-1',
      parentToolCallId: 'tool-1',
      resultSummary: 'Found the event boundary.',
      contextTokens: 512,
    })

    expect(useSubagentStore.getState().agents).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        subagentId: 'agent-1',
        name: 'explorer',
        runInBackground: true,
        status: 'completed',
        resultSummary: 'Found the event boundary.',
        contextTokens: 512,
      }),
    ])
  })

  it('keeps running agents while clearing finished records for one session', () => {
    const store = useSubagentStore.getState()
    store.spawned('session-a', {
      type: 'subagent.spawned',
      subagentId: 'agent-running',
      subagentName: 'worker',
      parentToolCallId: 'tool-running',
      runInBackground: false,
    })
    store.spawned('session-a', {
      type: 'subagent.spawned',
      subagentId: 'agent-failed',
      subagentName: 'reviewer',
      parentToolCallId: 'tool-failed',
      runInBackground: true,
    })
    store.failed('session-a', {
      type: 'subagent.failed',
      subagentId: 'agent-failed',
      parentToolCallId: 'tool-failed',
      error: 'Review stopped',
    })
    store.spawned('session-b', {
      type: 'subagent.spawned',
      subagentId: 'agent-other',
      subagentName: 'explorer',
      parentToolCallId: 'tool-other',
      runInBackground: true,
    })
    store.completed('session-b', {
      type: 'subagent.completed',
      subagentId: 'agent-other',
      parentToolCallId: 'tool-other',
      resultSummary: 'Done',
    })

    store.clearCompleted('session-a')

    expect(useSubagentStore.getState().agents).toEqual([
      expect.objectContaining({ subagentId: 'agent-other', status: 'completed' }),
      expect.objectContaining({ subagentId: 'agent-running', status: 'running' }),
    ])
  })

  it('rehydrates persisted background agents after a desktop restart', () => {
    useSubagentStore.getState().hydrateTasks('session-a', [
      {
        taskId: 'agent-task-1',
        command: 'Agent(worker)',
        description: 'Continue the verification pass',
        status: 'running',
        pid: 0,
        exitCode: null,
        startedAt: 42,
        endedAt: null,
        agentId: 'agent-persisted',
        subagentType: 'worker',
      },
    ])

    expect(useSubagentStore.getState().agents).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        subagentId: 'agent-persisted',
        name: 'worker',
        description: 'Continue the verification pass',
        status: 'running',
        startedAt: 42,
      }),
    ])
  })
})
