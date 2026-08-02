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
      getNoProjectWorkDir(): Promise<string>
      createSession(opts: {
        workDir?: string
        noProject?: boolean
        model?: string
        thinking?: string
        permission?: 'yolo' | 'manual' | 'auto'
      }): Promise<unknown>
      createGoal(sessionId: string, objective: string, replace?: boolean): Promise<unknown>
      getGitSnapshot(sessionId: string): Promise<unknown>
      getGitFileDiff(sessionId: string, filePath: string): Promise<unknown>
      setGitFileStaged(sessionId: string, filePath: string, staged: boolean): Promise<void>
      setAllGitFilesStaged(sessionId: string, staged: boolean): Promise<void>
      applyGitHunkAction(sessionId: string, input: {
        filePath: string
        sectionKind: 'staged' | 'unstaged'
        hunkIndex: number
        action: 'stage' | 'unstage' | 'revert'
      }): Promise<void>
      discardGitFileChanges(
        sessionId: string,
        filePath: string,
        scope: 'unstaged' | 'all',
      ): Promise<void>
      discardAllGitChanges(sessionId: string): Promise<void>
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
      sendMessage(sessionId: string, request: unknown): Promise<void>
      steerMessage(sessionId: string, request: unknown): Promise<void>
      readFileAttachment(filePath: string): Promise<unknown>
      readInlineImageAttachment(name: string, dataUrl: string): Promise<unknown>
      getSessionStatus(sessionId: string): Promise<unknown>
      setPermission(sessionId: string, mode: 'yolo' | 'manual' | 'auto'): Promise<void>
      getProviderUsage(force?: boolean): Promise<unknown>
      onInteractionSettled(callback: (payload: unknown) => void): () => void
      onTerminalOutput(callback: (payload: unknown) => void): () => void
      onMenuCommand(callback: (payload: unknown) => void): () => void
      updateMenuState(state: {
        hasActiveSession: boolean
        canFindInConversation: boolean
        sidebarOpen: boolean
        canGoPrevious: boolean
        canGoNext: boolean
      }): void
      respondApproval(payload: unknown): Promise<void>
      respondQuestion(payload: unknown): Promise<void>
    }
    const approval = { requestId: 'approval-1', response: { decision: 'cancelled' } }
    const question = { requestId: 'question-1', result: null }
    const file = { name: 'file.txt' } as File

    expect(api.getPathForFile(file)).toBe('C:/work/file.txt')
    await api.exportSession('session-1')
    await api.selectWorkDirectory('C:/work')
    await api.getNoProjectWorkDir()
    await api.createSession({ noProject: true })
    await api.createGoal('session-1', 'ship desktop', true)
    await api.getGitSnapshot('session-1')
    await api.getGitFileDiff('session-1', 'src/app.ts')
    await api.setGitFileStaged('session-1', 'src/app.ts', true)
    await api.setAllGitFilesStaged('session-1', false)
    const hunkAction = {
      filePath: 'src/app.ts',
      sectionKind: 'unstaged' as const,
      hunkIndex: 1,
      action: 'stage' as const,
    }
    await api.applyGitHunkAction('session-1', hunkAction)
    await api.discardGitFileChanges('session-1', 'src/app.ts', 'unstaged')
    await api.discardAllGitChanges('session-1')
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
    const promptRequest = {
      text: 'change direction',
      attachments: [{ source: 'path', kind: 'image', filePath: 'C:/work/screen.png' }],
    }
    await api.sendMessage('session-1', promptRequest)
    await api.steerMessage('session-1', promptRequest)
    await api.readFileAttachment('C:/work/screen.png')
    await api.readInlineImageAttachment('clipboard.png', 'data:image/png;base64,abc=')
    await api.getSessionStatus('session-1')
    await api.setPermission('session-1', 'auto')
    await api.getProviderUsage(true)
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

    const onMenuCommand = vi.fn()
    const unsubscribeMenuCommand = api.onMenuCommand(onMenuCommand)
    const menuCommandListener = electron.on.mock.calls.find(
      ([channel]) => channel === 'lmcode:menuCommand',
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
    const menuCommandPayload = { command: 'show-terminal' }
    menuCommandListener?.({}, menuCommandPayload)
    unsubscribeMenuCommand()

    const menuState = {
      hasActiveSession: true,
      canFindInConversation: true,
      sidebarOpen: false,
      canGoPrevious: true,
      canGoNext: false,
    }
    api.updateMenuState(menuState)

    expect(electron.invoke).toHaveBeenCalledWith('lmcode:exportSession', 'session-1')
    expect(electron.getPathForFile).toHaveBeenCalledWith(file)
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:selectWorkDirectory', 'C:/work')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:getNoProjectWorkDir')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:createSession', { noProject: true })
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
      'lmcode:setAllGitFilesStaged',
      'session-1',
      false,
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:applyGitHunkAction',
      'session-1',
      hunkAction,
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:discardGitFileChanges',
      'session-1',
      'src/app.ts',
      'unstaged',
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:discardAllGitChanges',
      'session-1',
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
      'lmcode:sendMessage',
      'session-1',
      promptRequest,
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:steerMessage',
      'session-1',
      promptRequest,
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:readFileAttachment',
      'C:/work/screen.png',
    )
    expect(electron.invoke).toHaveBeenCalledWith(
      'lmcode:readInlineImageAttachment',
      'clipboard.png',
      'data:image/png;base64,abc=',
    )
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:getSessionStatus', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:setPermission', 'session-1', 'auto')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:getProviderUsage', true)
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:respondApproval', approval)
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:respondQuestion', question)
    expect(onSettled).toHaveBeenCalledWith(settledPayload)
    expect(onTerminalOutput).toHaveBeenCalledWith(terminalPayload)
    expect(onMenuCommand).toHaveBeenCalledWith(menuCommandPayload)
    expect(electron.removeListener).toHaveBeenCalledWith('lmcode:interactionSettled', listener)
    expect(electron.removeListener).toHaveBeenCalledWith('lmcode:terminalOutput', terminalListener)
    expect(electron.removeListener).toHaveBeenCalledWith(
      'lmcode:menuCommand',
      menuCommandListener,
    )
    expect(electron.send).toHaveBeenCalledWith('lmcode:updateMenuState', menuState)
  })
})
