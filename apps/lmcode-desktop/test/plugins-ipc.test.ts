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
    listeners: { webContents: webContentsListeners, window: windowListeners },
  }
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.invokeHandlers.get(channel)
  if (handler === undefined) throw new Error(`Missing invoke handler: ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

const PLUGIN_SUMMARY = {
  id: 'plugin-a',
  displayName: 'Plugin A',
  version: '1.0.0',
  enabled: true,
  state: 'ok',
  skillCount: 2,
  skills: [],
  mcpServerCount: 1,
  enabledMcpServerCount: 1,
  hasErrors: false,
  source: 'github',
  originalSource: 'owner/repo-a',
  github: { owner: 'owner', repo: 'repo-a', ref: { kind: 'branch', value: 'main' } },
} as const

describe('desktop plugin IPC', () => {
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
    memory.close.mockResolvedValue(undefined)
  })

  async function setupActiveSession() {
    const session = {
      id: 'session-plugins',
      summary: { id: 'session-plugins', workDir: 'C:/work' },
      onEvent: vi.fn(() => vi.fn()),
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
      listPlugins: vi.fn(async () => [PLUGIN_SUMMARY]),
      installPlugin: vi.fn(async (source: string) => ({ ...PLUGIN_SUMMARY, originalSource: source })),
      setPluginEnabled: vi.fn(async () => undefined),
      setPluginMcpServerEnabled: vi.fn(async () => undefined),
      removePlugin: vi.fn(async () => undefined),
      reloadPlugins: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
      getPluginInfo: vi.fn(async () => ({ ...PLUGIN_SUMMARY, root: 'C:/plugins/a' })),
    }
    const harness = {
      configPath: 'C:/Users/test/.lmcode/config.toml',
      createSession: vi.fn(async () => session),
    }
    const registration = registerAllHandlers(
      harness as never,
      createWindow() as never,
      'file:///renderer/index.html',
    )
    await invoke('lmcode:createSession', { workDir: 'C:/work' })
    return { session, registration }
  }

  it('lists plugins of the active session', async () => {
    const { session, registration } = await setupActiveSession()
    await expect(invoke('lmcode:listPlugins', 'session-plugins')).resolves.toEqual([
      PLUGIN_SUMMARY,
    ])
    expect(session.listPlugins).toHaveBeenCalledOnce()
    await registration.close()
  })

  it('forwards install source and returns the installed summary', async () => {
    const { session, registration } = await setupActiveSession()
    await expect(invoke('lmcode:installPlugin', 'session-plugins', 'owner/repo-a')).resolves.toEqual(
      expect.objectContaining({ id: 'plugin-a' }),
    )
    expect(session.installPlugin).toHaveBeenCalledWith('owner/repo-a')
    await registration.close()
  })

  it('forwards plugin enable/disable and MCP server enable/disable', async () => {
    const { session, registration } = await setupActiveSession()
    await invoke('lmcode:setPluginEnabled', 'session-plugins', 'plugin-a', false)
    await invoke(
      'lmcode:setPluginMcpServerEnabled',
      'session-plugins',
      'plugin-a',
      'mcp-1',
      true,
    )
    expect(session.setPluginEnabled).toHaveBeenCalledWith('plugin-a', false)
    expect(session.setPluginMcpServerEnabled).toHaveBeenCalledWith('plugin-a', 'mcp-1', true)
    await registration.close()
  })

  it('forwards plugin removal', async () => {
    const { session, registration } = await setupActiveSession()
    await invoke('lmcode:removePlugin', 'session-plugins', 'plugin-a')
    expect(session.removePlugin).toHaveBeenCalledWith('plugin-a')
    await registration.close()
  })

  it('reloads plugins and reports the reload summary', async () => {
    const { session, registration } = await setupActiveSession()
    await expect(invoke('lmcode:reloadPlugins', 'session-plugins')).resolves.toEqual({
      added: [],
      removed: [],
      errors: [],
    })
    expect(session.reloadPlugins).toHaveBeenCalledOnce()
    await registration.close()
  })

  it('returns detailed plugin info', async () => {
    const { session, registration } = await setupActiveSession()
    await expect(invoke('lmcode:getPluginInfo', 'session-plugins', 'plugin-a')).resolves.toEqual(
      expect.objectContaining({ id: 'plugin-a', root: 'C:/plugins/a' }),
    )
    expect(session.getPluginInfo).toHaveBeenCalledWith('plugin-a')
    await registration.close()
  })

  it('rejects plugin access without an active session', async () => {
    const { registration } = await setupActiveSession()
    await expect(invoke('lmcode:listPlugins', 'no-such-session')).rejects.toThrow()
    await registration.close()
  })
})
