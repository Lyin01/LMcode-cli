import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@lmcode-cli/lmcode-sdk'
import { InteractionHub } from '../src/main/remote/interaction-hub'
import { RemoteBridge } from '../src/main/remote/remote-bridge'

function fakeSession(): Session {
  return {
    id: 'session-a',
    summary: {
      id: 'session-a',
      workDir: 'E:\\projects\\app',
      sessionDir: 'E:\\sessions\\a',
      createdAt: 1,
      updatedAt: 1,
      title: 'fake',
    },
    workDir: 'E:\\projects\\app',
    onEvent: () => () => undefined,
    addMcpServer: vi.fn(async () => undefined),
    setPermission: vi.fn(async () => undefined),
  } as unknown as Session
}

function fakeHarness(session: Session) {
  const created: Array<{ workDir: string }> = []
  return {
    created,
    listSessions: async () => [session.summary],
    resumeSession: async () => session,
    createSession: async ({ workDir }: { workDir: string }) => {
      created.push({ workDir })
      return {
        summary: {
          id: 'session-new',
          workDir,
          sessionDir: 'E:\\sessions\\new',
          createdAt: 1,
          updatedAt: 1,
        },
      }
    },
    getConfig: async () => ({}),
    setConfig: vi.fn(async (patch: unknown) => patch),
    renameSession: async () => undefined,
    deleteSession: async () => undefined,
    closeSession: async () => undefined,
  }
}

function fakeMemoryStore() {
  return {
    list: async () => ({ memos: [], total: 0 }),
    delete: async () => true,
    close: async () => undefined,
  } as never
}

describe('RemoteBridge host-execution guards', () => {
  it('rejects sessions.create outside known project directories', async () => {
    const session = fakeSession()
    const harness = fakeHarness(session)
    const bridge = new RemoteBridge(harness as never, new InteractionHub(), 'C:/no-project', fakeMemoryStore())

    await expect(
      bridge.invoke('sessions.create', { workDir: 'C:\\Users\\me\\.ssh' }),
    ).rejects.toThrow(/existing desktop project directory/)
    expect(harness.created).toEqual([])

    const created = await bridge.invoke('sessions.create', { workDir: 'E:\\projects\\app' })
    expect(created).toMatchObject({ id: 'session-new', workDir: 'E:\\projects\\app' })

    await expect(
      bridge.invoke('sessions.create', { noProject: true, workDir: 'C:\\elsewhere' }),
    ).rejects.toThrow(/no-project/)
  })

  it('rejects stdio MCP add and yolo permission from a remote client', async () => {
    const session = fakeSession()
    const harness = fakeHarness(session)
    const bridge = new RemoteBridge(harness as never, new InteractionHub(), 'C:/no-project', fakeMemoryStore())

    await expect(
      bridge.invoke('mcp.add', {
        sessionId: 'session-a',
        name: 'evil',
        config: { command: 'calc.exe' },
      }),
    ).rejects.toThrow(/stdio command/)
    expect(session.addMcpServer).not.toHaveBeenCalled()

    await expect(
      bridge.invoke('control.permission', { sessionId: 'session-a', mode: 'yolo' }),
    ).rejects.toThrow(/yolo/)
    expect(session.setPermission).not.toHaveBeenCalled()
  })

  it('rejects config patches that persist hooks or yolo', async () => {
    const session = fakeSession()
    const harness = fakeHarness(session)
    const bridge = new RemoteBridge(harness as never, new InteractionHub(), 'C:/no-project', fakeMemoryStore())

    await expect(
      bridge.invoke('config.set', { patch: { yolo: true } }),
    ).rejects.toThrow(/yolo/)
    await expect(
      bridge.invoke('config.set', {
        patch: { hooks: [{ event: 'SessionStart', command: 'calc.exe' }] },
      }),
    ).rejects.toThrow(/hooks/)
    expect(harness.setConfig).not.toHaveBeenCalled()
  })
})
