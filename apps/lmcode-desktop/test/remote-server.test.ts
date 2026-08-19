import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Session } from '@lmcode-cli/lmcode-sdk'
import { InteractionHub } from '../src/main/remote/interaction-hub'
import { RemoteBridge } from '../src/main/remote/remote-bridge'
import { RemoteServer } from '../src/main/remote/remote-server'
import type { RemoteClientMessage, RemoteServerMessage, RemoteState } from '../src/shared/remote-types'

// ── Minimal fakes ──────────────────────────────────────────────────────

function fakeHarness() {
  const sessions = new Map<string, Session>()
  return {
    configPath: 'C:/fake/.lmcode/config.toml',
    homeDir: 'C:/fake/.lmcode',
    listSessions: async () => [],
    resumeSession: async ({ id }: { id: string }) => {
      const existing = sessions.get(id)
      if (existing) return existing
      const summary = {
        id,
        workDir: 'C:/work',
        sessionDir: 'C:/sessions/' + id,
        createdAt: 1,
        updatedAt: 1,
        title: 'fake',
      }
      const session = {
        id,
        summary,
        workDir: 'C:/work',
        onEvent: () => () => undefined,
        getContext: async () => ({ history: [{ role: 'user', content: 'hi' }] }),
        getStatus: async () => ({
          thinkingLevel: 'medium',
          permission: 'manual',
          planMode: false,
          contextTokens: 0,
          maxContextTokens: 1000,
          contextUsage: 0,
        }),
        prompt: async () => undefined,
        steer: async () => undefined,
        cancel: async () => undefined,
        setModel: async () => undefined,
        setThinking: async () => undefined,
        setPermission: async () => undefined,
        setPlanMode: async () => undefined,
        getResumeState: () => undefined,
        createGoal: async () => ({
          goalId: 'g1',
          objective: 'test',
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          wallClockMs: 0,
          budget: null,
          notes: [],
        }),
        getGoal: async () => ({ goal: null }),
        updateGoalStatus: async () => null,
        cancelGoal: async () => null,
        listCronJobs: async () => [],
        createCronJob: async () => ({ id: 'c1', cron: '* * * * *', prompt: 'p' }),
        deleteCronJob: async () => undefined,
        listBackgroundTasks: async () => [],
        stopBackgroundTask: async () => undefined,
        getBackgroundTaskOutput: async () => '',
        listSkills: async () => [],
        activateSkill: async () => undefined,
        listMcpServers: async () => [],
        reconnectMcpServer: async () => undefined,
        addMcpServer: async () => undefined,
        stopMcpServer: async () => undefined,
        removeMcpServer: async () => undefined,
        close: async () => undefined,
      } as unknown as Session
      sessions.set(id, session)
      return session
    },
    createSession: async () => sessions.values().next().value,
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

interface OpenedServer {
  server: RemoteServer
  bridge: RemoteBridge
  hub: InteractionHub
  url: string
  state: () => RemoteState
  close(): Promise<void>
}

async function openServer(token = 'test-token'): Promise<OpenedServer> {
  const hub = new InteractionHub()
  const harness = fakeHarness() as never
  const bridge = new RemoteBridge(harness, hub, 'C:/no-project', fakeMemoryStore())
  const state: RemoteState = {
    enabled: true,
    port: 0,
    token,
    lanUrls: ['http://127.0.0.1:0'],
    clientCount: 0,
    version: 'test',
  }
  const server: RemoteServer = new RemoteServer({
    bridge,
    hub,
    getToken: () => token,
    getState: () => ({ ...state, clientCount: server.clientCount }),
  })
  await server.listen(0)
  const address = server['httpServer'].address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    server,
    bridge,
    hub,
    url: `ws://127.0.0.1:${port}/ws`,
    state: () => ({ ...state, clientCount: server.clientCount }),
    close: async () => {
      await server.close()
      await bridge.close()
    },
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage<T extends { type: string } = RemoteServerMessage>(
  ws: WebSocket,
  type?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2000)
    const onMessage = (data: Buffer): void => {
      const message = JSON.parse(data.toString('utf8')) as RemoteServerMessage
      if (type !== undefined && message.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message as unknown as T)
    }
    ws.on('message', onMessage)
  })
}

function send(ws: WebSocket, message: RemoteClientMessage): void {
  ws.send(JSON.stringify(message))
}

let servers: OpenedServer[] = []

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
})

describe('RemoteServer protocol', () => {
  it('does not attach unauthenticated sockets to the event fan-out', async () => {
    const opened = await openServer()
    servers.push(opened)
    const ws = await connect(opened.url)
    expect(opened.server.clientCount).toBe(0)
    opened.server.broadcastState()
    await expect(nextMessage(ws, 'server-state')).rejects.toThrow(/message timeout/)
  })

  it('rejects a socket that does not authenticate first', async () => {
    const opened = await openServer()
    servers.push(opened)
    const ws = await connect(opened.url)
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
    send(ws, { type: 'ping', t: 1 })
    await closed
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects an invalid token', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
    send(ws, { type: 'auth', token: 'wrong' })
    await closed
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('authenticates with the right token and answers requests', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)

    send(ws, { type: 'auth', token: 'secret' })
    const authOk = await nextMessage<{ type: 'auth-ok' }>(ws, 'auth-ok')
    expect(authOk.type).toBe('auth-ok')

    send(ws, {
      type: 'request',
      id: 'req-1',
      method: 'sessions.list',
      params: {},
    })
    const response = await nextMessage<{ type: 'response'; id: string; ok: boolean; result?: unknown }>(
      ws,
      'response',
    )
    expect(response.id).toBe('req-1')
    expect(response.ok).toBe(true)
    expect(response.result).toEqual([])

    send(ws, {
      type: 'request',
      id: 'req-2',
      method: 'sessions.history',
      params: { id: 'session-a' },
    })
    const history = await nextMessage<{ type: 'response'; id: string; ok: boolean; result?: unknown }>(
      ws,
      'response',
    )
    expect(history.ok).toBe(true)
    expect(history.result).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('reports method errors in the response instead of dropping the socket', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    send(ws, { type: 'auth', token: 'secret' })
    await nextMessage(ws, 'auth-ok')

    send(ws, { type: 'request', id: 'bad', method: 'sessions.history', params: {} })
    const response = await nextMessage<{ type: 'response'; ok: boolean; error?: string }>(
      ws,
      'response',
    )
    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/missing required string parameter "id"/)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('rejects unknown methods', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    send(ws, { type: 'auth', token: 'secret' })
    await nextMessage(ws, 'auth-ok')

    send(ws, { type: 'request', id: 'x', method: 'nope.unknown', params: {} })
    const response = await nextMessage<{ type: 'response'; ok: boolean; error?: string }>(ws, 'response')
    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/Unknown remote method/)
  })

  it('answers ping with pong', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    send(ws, { type: 'auth', token: 'secret' })
    await nextMessage(ws, 'auth-ok')

    send(ws, { type: 'ping', t: 42 })
    const pong = await nextMessage<{ type: 'pong'; t: number }>(ws, 'pong')
    expect(pong.t).toBe(42)
  })

  it('forwards session events to connected clients', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    send(ws, { type: 'auth', token: 'secret' })
    await nextMessage(ws, 'auth-ok')

    send(ws, { type: 'request', id: 'h', method: 'sessions.history', params: { id: 'session-a' } })
    await nextMessage(ws, 'response')

    // Emit an event through the bridge as the SDK would.
    opened.bridge['broadcastEvent']('session-a', {
      type: 'session.meta.updated',
      sessionId: 'session-a',
      agentId: 'main',
      title: 'renamed',
      patch: { title: 'renamed' },
    } as never)

    const event = await nextMessage<{ type: 'event'; sessionId: string }>(ws, 'event')
    expect(event.sessionId).toBe('session-a')
  })

  it('broadcasts approval requests and accepts a client response', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    send(ws, { type: 'auth', token: 'secret' })
    await nextMessage(ws, 'auth-ok')

    // Drive the hub exactly as the SDK's reverse-RPC handler would: the hub
    // fans the request out to the remote surface, which pushes it to the socket.
    const pending = opened.hub.requestApproval('session-a', { toolCallId: 't1', toolName: 'Bash', action: 'run', display: { kind: 'generic', summary: 'run' } })
    const approvalMsg = await nextMessage<{
      type: 'approval'
      requestId: string
      sessionId: string
      request: { action: string }
    }>(ws, 'approval')
    expect(approvalMsg.sessionId).toBe('session-a')
    expect(approvalMsg.request.action).toBe('run')

    send(ws, {
      type: 'approval',
      requestId: approvalMsg.requestId,
      response: { decision: 'approved' },
    })
    await expect(pending).resolves.toEqual({ decision: 'approved' })
  })

  it('tracks and broadcasts client count changes in state', async () => {
    const opened = await openServer('secret')
    servers.push(opened)
    const ws = await connect(opened.url)
    send(ws, { type: 'auth', token: 'secret' })
    await nextMessage(ws, 'auth-ok')
    expect(opened.state().clientCount).toBe(1)

    const ws2 = await connect(opened.url)
    send(ws2, { type: 'auth', token: 'secret' })
    await nextMessage(ws2, 'auth-ok')
    expect(opened.state().clientCount).toBe(2)

    ws2.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(opened.state().clientCount).toBe(1)
  })
})
