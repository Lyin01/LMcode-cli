import { beforeEach, describe, expect, it } from 'vitest'
import { useTaskStore } from '../src/renderer/stores/task-store'

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

describe('desktop task store', () => {
  beforeEach(() => {
    useTaskStore.setState({ tasks: [] })
  })

  it('appends a new task and updates it in place on later events', () => {
    const store = useTaskStore.getState()
    store.addOrUpdateTask('session-a', makeTask())
    store.addOrUpdateTask('session-a', makeTask({ taskId: 'task-2', command: 'pnpm build' }))

    expect(useTaskStore.getState().tasks.map((t) => t.taskId)).toEqual(['task-1', 'task-2'])

    store.addOrUpdateTask('session-a', makeTask({ status: 'completed', exitCode: 0, endedAt: 2000 }))

    const tasks = useTaskStore.getState().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ taskId: 'task-1', status: 'completed', exitCode: 0, endedAt: 2000 })
    // The other task must keep its own state (no cross-task bleed).
    expect(tasks[1]).toMatchObject({ taskId: 'task-2', status: 'running' })
  })

  it('records which session a task belongs to', () => {
    useTaskStore.getState().addOrUpdateTask('session-b', makeTask())
    expect(useTaskStore.getState().tasks[0]?.sessionId).toBe('session-b')
  })

  it('removes and clears tasks', () => {
    const store = useTaskStore.getState()
    store.addOrUpdateTask('session-a', makeTask())
    store.addOrUpdateTask('session-a', makeTask({ taskId: 'task-2' }))

    useTaskStore.getState().removeTask('task-1')
    expect(useTaskStore.getState().tasks.map((t) => t.taskId)).toEqual(['task-2'])

    useTaskStore.getState().clearTasks()
    expect(useTaskStore.getState().tasks).toEqual([])
  })
})
