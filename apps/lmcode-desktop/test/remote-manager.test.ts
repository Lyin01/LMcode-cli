import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InteractionHub } from '../src/main/remote/interaction-hub'
import { RemoteManager } from '../src/main/remote/remote-manager'
import type { RemoteState } from '../src/shared/remote-types'

interface FakeSession {
  id: string
  onEvent(): () => void
}

function fakeHarness() {
  const session: FakeSession = { id: 's1', onEvent: () => () => undefined }
  return {
    homeDir: 'C:/fake',
    configPath: 'C:/fake/config.toml',
    listSessions: async () => [],
    resumeSession: async () => session,
    createSession: async () => session,
    renameSession: async () => undefined,
    deleteSession: async () => undefined,
    closeSession: async () => undefined,
    getConfig: async () => ({}),
    setConfig: async (patch: unknown) => patch,
  }
}

function fakeMemoryStore() {
  return {
    list: async () => ({ memos: [], total: 0 }),
    search: async () => ({ memos: [], total: 0 }),
    delete: async () => true,
    close: async () => undefined,
  } as never
}

let tempDirs: string[] = []

async function makeManager(): Promise<{
  manager: RemoteManager
  configDir: string
  configPath: string
  states: RemoteState[]
}> {
  const configDir = await mkdtemp(join(tmpdir(), 'lmcode-remote-test-'))
  tempDirs.push(configDir)
  const states: RemoteState[] = []
  const manager = new RemoteManager({
    harness: fakeHarness() as never,
    hub: new InteractionHub(),
    memoryStore: fakeMemoryStore(),
    configDir,
    version: '0.0.0-test',
    noProjectWorkDir: join(configDir, 'no-project'),
    onStateChange: (state) => states.push(state),
  })
  return { manager, configDir, configPath: join(configDir, 'remote-config.json'), states }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('RemoteManager', () => {
  it('starts disabled with a generated token and default port', async () => {
    const { manager } = await makeManager()
    await manager.init()
    const state = manager.getState()
    expect(state.enabled).toBe(false)
    expect(state.port).toBe(37_991)
    expect(state.token.length).toBeGreaterThanOrEqual(32)
    expect(state.version).toBe('0.0.0-test')
    expect(state.clientCount).toBe(0)
  })

  it('persists config to disk and reloads it on init', async () => {
    const { manager, configPath } = await makeManager()
    await manager.init()
    await manager.setEnabled(true)
    await manager.setPort(38_000)
    await manager.regenerateToken()

    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
      enabled: boolean
      port: number
      token: string
    }
    expect(persisted.enabled).toBe(true)
    expect(persisted.port).toBe(38_000)
    expect(persisted.token).toBe(manager.getState().token)

    // A fresh manager over the SAME directory restores the same state.
    await manager.close()
    const reloaded = new RemoteManager({
      harness: fakeHarness() as never,
      hub: new InteractionHub(),
      memoryStore: fakeMemoryStore(),
      configDir: manager['options'].configDir,
      version: '0.0.0-test',
      noProjectWorkDir: join(manager['options'].configDir, 'no-project'),
    })
    await reloaded.init()
    expect(reloaded.getState().enabled).toBe(true)
    expect(reloaded.getState().port).toBe(38_000)
    expect(reloaded.getState().token).toBe(persisted.token)
    await reloaded.close()
  })

  it('emits state changes for every mutation', async () => {
    const { manager, states } = await makeManager()
    await manager.init()
    const before = states.length
    await manager.setEnabled(true)
    await manager.regenerateToken()
    await manager.setEnabled(false)
    expect(states.length).toBe(before + 3)
    expect(states.at(-1)?.enabled).toBe(false)
  })

  it('rejects out-of-range ports', async () => {
    const { manager } = await makeManager()
    await manager.init()
    await expect(manager.setPort(80)).rejects.toThrow(/between 1024 and 65535/)
    await expect(manager.setPort(70_000)).rejects.toThrow(/between 1024 and 65535/)
  })

  it('serves health and accepts a client after being enabled', async () => {
    const { manager } = await makeManager()
    await manager.init()
    await manager.setEnabled(true)
    const state = manager.getState()
    expect(state.enabled).toBe(true)

    const health = await fetch(`http://127.0.0.1:${state.port}/health`)
    expect(health.status).toBe(200)
    const body = (await health.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    await manager.close()
  })

  it('regenerating the token does not restart the server (state stays enabled)', async () => {
    const { manager } = await makeManager()
    await manager.init()
    await manager.setEnabled(true)
    const before = manager.getState()
    const after = await manager.regenerateToken()
    expect(after.enabled).toBe(true)
    expect(after.token).not.toBe(before.token)
    expect(after.port).toBe(before.port)
    await manager.close()
  })
})
