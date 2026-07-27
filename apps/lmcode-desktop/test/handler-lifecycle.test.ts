import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  const invokeHandlers = new Map<string, InvokeHandler>()
  const eventListeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  return {
    invokeHandlers,
    eventListeners,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      invokeHandlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      invokeHandlers.delete(channel)
    }),
    on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      eventListeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string) => {
      eventListeners.delete(channel)
    }),
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ['C:/work'],
    })),
    trashItem: vi.fn(async (): Promise<void> => undefined),
  }
})

const memory = vi.hoisted(() => ({
  close: vi.fn(async (): Promise<void> => undefined),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/Users/test'),
    getVersion: vi.fn(() => '0.1.0'),
    quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
    on: electron.on,
    removeListener: electron.removeListener,
  },
  dialog: { showOpenDialog: electron.showOpenDialog },
  shell: { trashItem: electron.trashItem },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
}))

vi.mock('@lmcode/memory', () => ({
  MemoryMemoStore: class {
    async list(): Promise<{ memos: []; total: number }> {
      return { memos: [], total: 0 }
    }

    async delete(): Promise<boolean> {
      return true
    }

    close(): Promise<void> {
      return memory.close()
    }
  },
}))

vi.mock('../src/main/security', () => ({
  isTrustedIpcSender: vi.fn(() => true),
}))

import { registerAllHandlers } from '../src/main/ipc/handler'

interface FakeSessionHandlers {
  approval: ((request: Record<string, unknown>) => Promise<unknown>) | undefined
  question: ((request: Record<string, unknown>) => Promise<unknown>) | undefined
}

function createWindow() {
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>()
  const windowListeners = new Map<string, (...args: unknown[]) => void>()
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        webContentsListeners.set(channel, listener)
      }),
      removeListener: vi.fn((channel: string) => {
        webContentsListeners.delete(channel)
      }),
    },
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      windowListeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string) => {
      windowListeners.delete(channel)
    }),
  }
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.invokeHandlers.get(channel)
  if (handler === undefined) throw new Error(`Missing invoke handler: ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

describe('desktop handler lifecycle', () => {
  beforeEach(() => {
    electron.invokeHandlers.clear()
    electron.eventListeners.clear()
    vi.clearAllMocks()
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:/work'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    memory.close.mockResolvedValue(undefined)
  })

  it('settles approval and question requests created before and during cancellation', async () => {
    const handlers: FakeSessionHandlers = { approval: undefined, question: undefined }
    let lateApproval: Promise<unknown> | undefined
    let lateQuestion: Promise<unknown> | undefined
    const session = {
      id: 'session-a',
      summary: { id: 'session-a' },
      onEvent: vi.fn(() => vi.fn()),
      setApprovalHandler: vi.fn((handler) => {
        handlers.approval = handler
      }),
      setQuestionHandler: vi.fn((handler) => {
        handlers.question = handler
      }),
      cancel: vi.fn(async () => {
        lateApproval = handlers.approval?.({ action: 'late approval' })
        lateQuestion = handlers.question?.({ questions: [] })
      }),
    }
    const harness = {
      configPath: 'C:/Users/test/.lmcode/config.toml',
      createSession: vi.fn(async () => session),
    }
    const mainWindow = createWindow()
    const registration = registerAllHandlers(
      harness as never,
      mainWindow as never,
      'file:///renderer/index.html',
    )
    await invoke('lmcode:createSession', { workDir: 'C:/work' })

    const earlyApproval = handlers.approval?.({ action: 'early approval' })
    const earlyQuestion = handlers.question?.({ questions: [] })
    await invoke('lmcode:cancelResponse', 'session-a')

    await expect(earlyApproval).resolves.toEqual({ decision: 'cancelled' })
    await expect(earlyQuestion).resolves.toBeNull()
    await expect(lateApproval).resolves.toEqual({ decision: 'cancelled' })
    await expect(lateQuestion).resolves.toBeNull()

    const requestedIds = mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === 'lmcode:approvalRequest' || channel === 'lmcode:questionRequest')
      .map(([, payload]) => (payload as { requestId: string }).requestId)
    const settledIds = mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === 'lmcode:interactionSettled')
      .map(([, payload]) => (payload as { requestId: string }).requestId)
    expect(new Set(settledIds)).toEqual(new Set(requestedIds))
    expect(settledIds).toHaveLength(4)

    await registration.close()
  })

  it('returns the selected project directory and preserves cancellation', async () => {
    const mainWindow = createWindow()
    const registration = registerAllHandlers(
      { configPath: 'C:/Users/test/.lmcode/config.toml' } as never,
      mainWindow as never,
      'file:///renderer/index.html',
    )

    await expect(invoke('lmcode:selectWorkDirectory', 'C:/existing')).resolves.toBe('C:/work')
    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({
        defaultPath: 'C:/existing',
        properties: expect.arrayContaining(['openDirectory']),
      }),
    )

    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(invoke('lmcode:selectWorkDirectory')).resolves.toBeUndefined()

    await registration.close()
  })

  it('bridges goal, plan, compaction, and history controls to the active SDK session', async () => {
    const goal = {
      goalId: 'goal-1',
      objective: 'ship desktop',
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budget: {
        tokenBudget: null,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: null,
        remainingTurns: null,
        remainingWallClockMs: null,
        overBudget: false,
      },
      notes: [],
    }
    const session = {
      id: 'session-controls',
      summary: { id: 'session-controls', workDir: 'C:/work' },
      onEvent: vi.fn(() => vi.fn()),
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
      createGoal: vi.fn(async () => goal),
      getGoal: vi.fn(async () => ({ goal })),
      updateGoalStatus: vi.fn(async () => ({ ...goal, status: 'paused' })),
      cancelGoal: vi.fn(async () => ({ ...goal, status: 'complete' })),
      setPlanMode: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
      undoHistory: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      listCronJobs: vi.fn(async () => []),
      createCronJob: vi.fn(async (input: Record<string, unknown>) => ({ id: 'abc12345', ...input })),
      deleteCronJob: vi.fn(async () => undefined),
      listBackgroundTasks: vi.fn(async () => []),
      stopBackgroundTask: vi.fn(async () => undefined),
      getBackgroundTaskOutput: vi.fn(async () => 'task output'),
      getStatus: vi.fn(async () => ({
        thinkingLevel: 'medium',
        permission: 'manual',
        planMode: false,
        contextTokens: 10,
        maxContextTokens: 1_000,
        contextUsage: 0.01,
      })),
    }
    const registration = registerAllHandlers(
      {
        configPath: 'C:/Users/test/.lmcode/config.toml',
        createSession: vi.fn(async () => session),
      } as never,
      createWindow() as never,
      'file:///renderer/index.html',
    )
    await invoke('lmcode:createSession', { workDir: 'C:/work' })

    await expect(
      invoke('lmcode:createGoal', 'session-controls', 'ship desktop', true),
    ).resolves.toEqual(goal)
    await expect(invoke('lmcode:getGoal', 'session-controls')).resolves.toEqual({ goal })
    await invoke('lmcode:updateGoalStatus', 'session-controls', 'paused')
    await invoke('lmcode:cancelGoal', 'session-controls')
    await invoke('lmcode:setPlanMode', 'session-controls', true)
    await invoke('lmcode:compactSession', 'session-controls', 'retain decisions')
    await invoke('lmcode:undoHistory', 'session-controls', 2)
    await invoke('lmcode:steerMessage', 'session-controls', {
      text: 'focus on the failing test',
      attachments: [],
    })
    await expect(invoke('lmcode:listCronJobs', 'session-controls')).resolves.toEqual([])
    await invoke('lmcode:createCronJob', 'session-controls', {
      cron: '0 9 * * 1-5',
      prompt: 'Run tests',
      recurring: true,
    })
    await invoke('lmcode:deleteCronJob', 'session-controls', 'abc12345')
    await expect(invoke('lmcode:listBackgroundTasks', 'session-controls')).resolves.toEqual([])
    await invoke('lmcode:stopTask', 'session-controls', 'task-1')
    await expect(invoke('lmcode:getTaskOutput', 'session-controls', 'task-1')).resolves.toBe(
      'task output',
    )
    await expect(invoke('lmcode:getSessionStatus', 'session-controls')).resolves.toEqual(
      expect.objectContaining({ contextTokens: 10, maxContextTokens: 1_000 }),
    )

    expect(session.createGoal).toHaveBeenCalledWith('ship desktop', { replace: true })
    expect(session.updateGoalStatus).toHaveBeenCalledWith('paused')
    expect(session.cancelGoal).toHaveBeenCalledOnce()
    expect(session.setPlanMode).toHaveBeenCalledWith(true)
    expect(session.compact).toHaveBeenCalledWith({ instruction: 'retain decisions' })
    expect(session.undoHistory).toHaveBeenCalledWith(2)
    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'focus on the failing test' },
    ])
    expect(session.createCronJob).toHaveBeenCalledWith({
      cron: '0 9 * * 1-5',
      prompt: 'Run tests',
      recurring: true,
    })
    expect(session.deleteCronJob).toHaveBeenCalledWith('abc12345')
    expect(session.listBackgroundTasks).toHaveBeenCalledWith({ activeOnly: false })
    expect(session.stopBackgroundTask).toHaveBeenCalledWith('task-1', {
      reason: 'Stopped from LMCODE Desktop',
    })
    expect(session.getBackgroundTaskOutput).toHaveBeenCalledWith('task-1')

    await registration.close()
  })

  it('waits for memory close and removes registered IPC handlers during cleanup', async () => {
    const deferred = Promise.withResolvers<void>()
    memory.close.mockReturnValueOnce(deferred.promise)
    const mainWindow = createWindow()
    const registration = registerAllHandlers(
      { configPath: 'C:/Users/test/.lmcode/config.toml' } as never,
      mainWindow as never,
      'file:///renderer/index.html',
    )
    const registeredChannels = [...electron.invokeHandlers.keys()]
    let cleanupSettled = false

    const cleanup = registration.close().finally(() => {
      cleanupSettled = true
    })
    await vi.waitFor(() => {
      expect(memory.close).toHaveBeenCalledOnce()
    })
    expect(cleanupSettled).toBe(false)
    expect(electron.removeHandler).toHaveBeenCalledTimes(registeredChannels.length)

    deferred.resolve()
    await cleanup
    expect(cleanupSettled).toBe(true)
    expect(electron.invokeHandlers.size).toBe(0)
  })

  it('deduplicates session selection and concurrent status hydration', async () => {
    const session = {
      id: 'session-resume',
      summary: { id: 'session-resume', workDir: 'C:/work' },
      onEvent: vi.fn(() => vi.fn()),
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
      getResumeState: vi.fn(() => ({ context: { history: [] } })),
      getStatus: vi.fn(async () => ({
        thinkingLevel: 'high',
        permission: 'auto',
        planMode: false,
        contextTokens: 42,
        maxContextTokens: 1_000,
        contextUsage: 0.042,
      })),
    }
    const resume = Promise.withResolvers<typeof session>()
    const harness = {
      configPath: 'C:/Users/test/.lmcode/config.toml',
      listSessions: vi.fn(async () => []),
      resumeSession: vi.fn(() => resume.promise),
    }
    const registration = registerAllHandlers(
      harness as never,
      createWindow() as never,
      'file:///renderer/index.html',
    )

    const selected = invoke('lmcode:resumeSession', 'session-resume')
    const status = invoke('lmcode:getSessionStatus', 'session-resume')
    await vi.waitFor(() => {
      expect(harness.resumeSession).toHaveBeenCalledTimes(1)
    })
    resume.resolve(session)

    await expect(selected).resolves.toEqual({
      summary: session.summary,
      resumeState: { context: { history: [] } },
    })
    await expect(status).resolves.toEqual(expect.objectContaining({ contextTokens: 42 }))
    expect(session.onEvent).toHaveBeenCalledTimes(1)

    await registration.close()
  })

  it('does not attach a resumed session after its renderer registration closes', async () => {
    const session = {
      id: 'session-late',
      onEvent: vi.fn(() => vi.fn()),
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
      getContext: vi.fn(async () => ({ history: [] })),
    }
    const resume = Promise.withResolvers<typeof session>()
    const harness = {
      configPath: 'C:/Users/test/.lmcode/config.toml',
      resumeSession: vi.fn(() => resume.promise),
    }
    const registration = registerAllHandlers(
      harness as never,
      createWindow() as never,
      'file:///renderer/index.html',
    )

    const history = invoke('lmcode:getSessionHistory', 'session-late')
    await vi.waitFor(() => {
      expect(harness.resumeSession).toHaveBeenCalledWith({ id: 'session-late' })
    })
    await registration.close()
    resume.resolve(session)

    await expect(history).rejects.toThrow('Desktop IPC registration is closed')
    expect(session.onEvent).not.toHaveBeenCalled()
    expect(session.setApprovalHandler).not.toHaveBeenCalled()
    expect(session.setQuestionHandler).not.toHaveBeenCalled()
    expect(session.getContext).not.toHaveBeenCalled()
  })

  it('expires an unanswered reverse-RPC request and dismisses its renderer interaction', async () => {
    vi.useFakeTimers()
    const handlers: FakeSessionHandlers = { approval: undefined, question: undefined }
    const session = {
      id: 'session-timeout',
      summary: { id: 'session-timeout' },
      onEvent: vi.fn(() => vi.fn()),
      setApprovalHandler: vi.fn((handler) => {
        handlers.approval = handler
      }),
      setQuestionHandler: vi.fn((handler) => {
        handlers.question = handler
      }),
    }
    const mainWindow = createWindow()
    const registration = registerAllHandlers(
      {
        configPath: 'C:/Users/test/.lmcode/config.toml',
        createSession: vi.fn(async () => session),
      } as never,
      mainWindow as never,
      'file:///renderer/index.html',
    )
    await invoke('lmcode:createSession', { workDir: 'C:/work' })

    const request = handlers.approval?.({ action: 'unanswered approval' })
    const requestPayload = mainWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === 'lmcode:approvalRequest',
    )?.[1] as { requestId: string } | undefined
    await vi.advanceTimersByTimeAsync(300_000)

    await expect(request).resolves.toEqual({ decision: 'cancelled' })
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'lmcode:interactionSettled',
      expect.objectContaining({ requestId: requestPayload?.requestId }),
    )
    await registration.close()
  })
})
