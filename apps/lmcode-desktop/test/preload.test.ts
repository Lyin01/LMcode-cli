import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn(() => 'C:/work/file.txt'),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send,
  },
  webUtils: { getPathForFile: electron.getPathForFile },
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('desktop preload bridge', () => {
  it('exposes only the narrow lmcode API and acknowledges dialog responses', async () => {
    await import('../src/preload/index')

    expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith('lmcodeAPI', expect.any(Object))

    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as {
      exportSession(id: string): Promise<string>
      getPathForFile(file: File): string
      selectWorkDirectory(initialDirectory?: string): Promise<string | undefined>
      createGoal(sessionId: string, objective: string, replace?: boolean): Promise<unknown>
      getGitSnapshot(sessionId: string): Promise<unknown>
      getGitFileDiff(sessionId: string, filePath: string): Promise<unknown>
      setGitFileStaged(sessionId: string, filePath: string, staged: boolean): Promise<void>
      commitGitChanges(sessionId: string, message: string): Promise<unknown>
      listCronJobs(sessionId: string): Promise<unknown>
      createCronJob(sessionId: string, input: unknown): Promise<unknown>
      deleteCronJob(sessionId: string, id: string): Promise<void>
      listBackgroundTasks(sessionId: string): Promise<unknown>
      stopTask(sessionId: string, taskId: string): Promise<void>
      getTaskOutput(sessionId: string, taskId: string): Promise<string>
      startTerminal(sessionId: string): Promise<unknown>
      writeTerminal(sessionId: string, input: string): Promise<void>
      listGitWorktrees(sessionId: string): Promise<unknown>
      createWorktreeHandoff(sessionId: string, branchName: string): Promise<unknown>
      handoffToWorktree(sessionId: string, worktreePath: string): Promise<unknown>
      steerMessage(sessionId: string, text: string): Promise<void>
      getSessionStatus(sessionId: string): Promise<unknown>
      onInteractionSettled(callback: (payload: unknown) => void): () => void
      onTerminalOutput(callback: (payload: unknown) => void): () => void
      respondApproval(payload: unknown): Promise<void>
      respondQuestion(payload: unknown): Promise<void>
    }
    const approval = { requestId: 'approval-1', response: { decision: 'cancelled' } }
    const question = { requestId: 'question-1', result: null }
    const file = { name: 'file.txt' } as File

    expect(api.getPathForFile(file)).toBe('C:/work/file.txt')
    await api.exportSession('session-1')
    await api.selectWorkDirectory('C:/work')
    await api.createGoal('session-1', 'ship desktop', true)
    await api.getGitSnapshot('session-1')
    await api.getGitFileDiff('session-1', 'src/app.ts')
    await api.setGitFileStaged('session-1', 'src/app.ts', true)
    await api.commitGitChanges('session-1', 'Update app')
    await api.listCronJobs('session-1')
    await api.createCronJob('session-1', {
      cron: '0 9 * * 1-5',
      prompt: 'Run tests',
      recurring: true,
    })
    await api.deleteCronJob('session-1', 'abc12345')
    await api.listBackgroundTasks('session-1')
    await api.stopTask('session-1', 'task-1')
    await api.getTaskOutput('session-1', 'task-1')
    await api.startTerminal('session-1')
    await api.writeTerminal('session-1', 'git status\n')
    await api.listGitWorktrees('session-1')
    await api.createWorktreeHandoff('session-1', 'lmcode/feature')
    await api.handoffToWorktree('session-1', 'C:/worktrees/feature')
    await api.steerMessage('session-1', 'change direction')
    await api.getSessionStatus('session-1')
    await api.respondApproval(approval)
    await api.respondQuestion(question)

    const onSettled = vi.fn()
    const unsubscribe = api.onInteractionSettled(onSettled)
    const listener = electron.on.mock.calls.find(
      ([channel]) => channel === 'lmcode:interactionSettled',
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
    const settledPayload = { sessionId: 'session-1', requestId: 'approval-1' }
    listener?.({}, settledPayload)
    unsubscribe()

    const onTerminalOutput = vi.fn()
    const unsubscribeTerminal = api.onTerminalOutput(onTerminalOutput)
    const terminalListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'lmcode:terminalOutput',
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
    const terminalPayload = { sessionId: 'session-1', stream: 'stdout', data: 'clean' }
    terminalListener?.({}, terminalPayload)
    unsubscribeTerminal()

    expect(electron.invoke).toHaveBeenCalledWith('lmcode:exportSession', 'session-1')
    expect(electron.getPathForFile).toHaveBeenCalledWith(file)
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:selectWorkDirectory', 'C:/work')
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:createGoal',
      'session-1',
      'ship desktop',
      true,
    )
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:getGitSnapshot', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:getGitFileDiff',
      'session-1',
      'src/app.ts',
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:setGitFileStaged',
      'session-1',
      'src/app.ts',
      true,
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:commitGitChanges',
      'session-1',
      'Update app',
    )
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:listCronJobs', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:createCronJob',
      'session-1',
      { cron: '0 9 * * 1-5', prompt: 'Run tests', recurring: true },
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:deleteCronJob',
      'session-1',
      'abc12345',
    )
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:listBackgroundTasks', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:stopTask', 'session-1', 'task-1')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:getTaskOutput', 'session-1', 'task-1')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:startTerminal', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:writeTerminal',
      'session-1',
      'git status\n',
    )
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:listGitWorktrees', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:createWorktreeHandoff',
      'session-1',
      'lmcode/feature',
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:handoffToWorktree',
      'session-1',
      'C:/worktrees/feature',
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:steerMessage',
      'session-1',
      'change direction',
    )
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:getSessionStatus', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:respondApproval', approval)
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:respondQuestion', question)
    expect(onSettled).toHaveBeenCalledWith(settledPayload)
    expect(onTerminalOutput).toHaveBeenCalledWith(terminalPayload)
    expect(electron.removeListener).toHaveBeenCalledWith('lmcode:interactionSettled', listener)
    expect(electron.removeListener).toHaveBeenCalledWith('lmcode:terminalOutput', terminalListener)
    expect(electron.send).not.toHaveBeenCalled()
  })
})
