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
    await Promise.resolve()
    expect(memory.close).toHaveBeenCalledOnce()
    expect(cleanupSettled).toBe(false)
    expect(electron.removeHandler).toHaveBeenCalledTimes(registeredChannels.length)

    deferred.resolve()
    await cleanup
    expect(cleanupSettled).toBe(true)
    expect(electron.invokeHandlers.size).toBe(0)
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
