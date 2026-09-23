import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { InteractionHub } from '../src/main/remote/interaction-hub'
import { RemoteManager, rankLanAddresses } from '../src/main/remote/remote-manager'
import type { RemoteState } from '../src/shared/remote-types'

interface FakeSession {
  id: string
  onEvent(): () => void
}

function fakeHarness() {
  const session: FakeSession = {
    id: 's1',
    onEvent: () => () => undefined,
    isOpen: true,
    setApprovalHandler: () => undefined,
    setQuestionHandler: () => undefined,
  } as FakeSession
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
    webRoot: join(configDir, 'remote-app'),
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
      webRoot: join(manager['options'].configDir, 'remote-app'),
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

  it('drops authenticated clients when the pairing token is regenerated', async () => {
    const { manager } = await makeManager()
    await manager.init()
    await manager.setPort(await getAvailablePort())
    await manager.setEnabled(true)
    const state = manager.getState()

    const ws = new WebSocket(`ws://127.0.0.1:${state.port}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ type: 'auth', token: state.token }))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 2000)
      ws.once('message', (data: Buffer) => {
        clearTimeout(timer)
        const message = JSON.parse(data.toString('utf8')) as { type: string }
        if (message.type === 'auth-ok') resolve()
        else reject(new Error(`unexpected ${message.type}`))
      })
    })
    expect(manager.getState().clientCount).toBe(1)

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    await manager.regenerateToken()
    await closed
    expect(manager.getState().clientCount).toBe(0)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('does not report enabled when the listen port is already taken', async () => {
    const blocker = createServer()
    const port = await getAvailablePort()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(port, '0.0.0.0', () => resolve())
    })
    try {
      const { manager } = await makeManager()
      await manager.init()
      await expect(manager.setPort(port).then(() => manager.setEnabled(true))).rejects.toThrow(
        /无法启动远程服务/,
      )
      expect(manager.getState().enabled).toBe(false)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('stops a server that was still starting when it was disabled', async () => {
    const { manager } = await makeManager()
    await manager.init()
    const port = await getAvailablePort()
    await manager.setPort(port)

    // A start that has been issued but has not published its server yet.
    const starting = manager['startServer']()
    const disabling = manager.setEnabled(false)
    await expect(starting).resolves.toBeUndefined()
    await disabling

    expect(manager.getState().enabled).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })

  it('reports disabled when the previous port cannot be restored either', async () => {
    const { manager, configPath, states } = await makeManager()
    await manager.init()
    await manager.setPort(await getAvailablePort())
    await manager.setEnabled(true)

    // Both the new port and the rollback start fail — e.g. something else
    // grabbed the old port while the manager was restarting.
    manager['startServer'] = async () => {
      throw new Error('port blocked')
    }
    await expect(manager.setPort(await getAvailablePort())).rejects.toThrow(/port blocked/)

    expect(manager.getState().enabled).toBe(false)
    expect(states.at(-1)?.enabled).toBe(false)
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as { enabled: boolean }
    expect(persisted.enabled).toBe(false)
  })
})

describe('rankLanAddresses', () => {
  it('prefers private LAN addresses over virtual-adapter addresses', () => {
    expect(rankLanAddresses(['2.0.0.1', '192.168.8.211'])).toEqual([
      '192.168.8.211',
      '2.0.0.1',
    ])
  })

  it('recognizes 10/8 and 172.16–31/12, and keeps link-local as the last resort', () => {
    expect(
      rankLanAddresses(['169.254.10.5', '100.64.0.2', '172.20.3.2', '10.0.0.4']),
    ).toEqual(['10.0.0.4', '172.20.3.2', '100.64.0.2', '169.254.10.5'])
  })

  it('orders equal-rank addresses deterministically', () => {
    expect(rankLanAddresses(['192.168.8.30', '192.168.8.4'])).toEqual([
      '192.168.8.30',
      '192.168.8.4',
    ])
  })
})
