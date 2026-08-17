import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
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
let managers: RemoteManager[] = []

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close(() => reject(new Error('Failed to allocate a test port')))
      return
    }
    server.close((error) => {
      if (error !== undefined) reject(error)
      else resolve(address.port)
    })
  })
  return promise
}

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
  managers.push(manager)
  return { manager, configDir, configPath: join(configDir, 'remote-config.json'), states }
}

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()))
  managers = []
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
    await manager.setPort(await getAvailablePort())
    await manager.setEnabled(true)
    const persistedPort = await getAvailablePort()
    await manager.setPort(persistedPort)
    await manager.regenerateToken()

    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
      enabled: boolean
      port: number
      token: string
    }
    expect(persisted.enabled).toBe(true)
    expect(persisted.port).toBe(persistedPort)
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
    managers.push(reloaded)
    await reloaded.init()
    expect(reloaded.getState().enabled).toBe(true)
    expect(reloaded.getState().port).toBe(persistedPort)
    expect(reloaded.getState().token).toBe(persisted.token)
  })

  it('emits state changes for every mutation', async () => {
    const { manager, states } = await makeManager()
    await manager.init()
    await manager.setPort(await getAvailablePort())
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
    await manager.setPort(await getAvailablePort())
    await manager.setEnabled(true)
    const state = manager.getState()
    expect(state.enabled).toBe(true)

    const health = await fetch(`http://127.0.0.1:${state.port}/health`)
    expect(health.status).toBe(200)
    const body = (await health.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('regenerating the token does not restart the server (state stays enabled)', async () => {
    const { manager } = await makeManager()
    await manager.init()
    await manager.setPort(await getAvailablePort())
    await manager.setEnabled(true)
    const before = manager.getState()
    const after = await manager.regenerateToken()
    expect(after.enabled).toBe(true)
    expect(after.token).not.toBe(before.token)
    expect(after.port).toBe(before.port)
  })
})
