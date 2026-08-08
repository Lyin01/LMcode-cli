import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { Logger } from '@lmcode-cli/lmcode-sdk'
import type {
  RemoteClientMessage,
  RemoteRequestMessage,
  RemoteServerMessage,
  RemoteState,
} from '../../shared/remote-types.js'
import { RemoteBridge, type RemoteConnection } from './remote-bridge.js'
import type { InteractionHub } from './interaction-hub.js'

const MAX_CLIENTS = 16
const AUTH_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 30_000
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const FAILED_AUTH_WINDOW_MS = 60_000
const FAILED_AUTH_LIMIT = 10

export interface RemoteServerOptions {
  readonly bridge: RemoteBridge
  readonly hub: InteractionHub
  /**
   * Current pairing token, read on every authentication attempt so that
   * regenerating the token takes effect immediately (old tokens stop working
   * without restarting the server).
   */
  readonly getToken: () => string
  /** Current service state, pushed to clients on auth and on changes. */
  readonly getState: () => RemoteState
  readonly logger?: Logger | undefined
}

/**
 * The remote surface's network entry point: a small HTTP server (health
 * probe) plus a WebSocket endpoint (`/ws`) speaking the protocol in
 * `remote-types.ts`.
 *
 * Security posture:
 * - the service only runs while the user has enabled it in settings;
 * - every socket must authenticate with `auth` as its first message, or it
 *   is closed immediately; failed attempts are rate-limited and logged;
 * - a client cap bounds the blast radius of a leaked token.
 */
export class RemoteServer {
  private readonly httpServer: Server
  private readonly wss: WebSocketServer
  private readonly sockets = new Set<WebSocket>()
  private readonly connections = new Map<WebSocket, RemoteConnection>()
  private readonly authTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  private failedAuthTimes: number[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(private readonly options: RemoteServerOptions) {
    this.httpServer = createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, name: 'lmcode-desktop-remote' }))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    })

    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })
    this.httpServer.on('upgrade', (request, socket: Socket, head) => {
      if (request.url !== '/ws') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', (socket: WebSocket) => {
      if (this.closed || this.sockets.size >= MAX_CLIENTS) {
        socket.close(1013, 'server busy')
        return
      }
      this.sockets.add(socket)
      this.options.logger?.info('remote client connected', {
        clientCount: this.sockets.size,
      })

      let authenticated = false
      const authTimer = setTimeout(() => {
        if (!authenticated) socket.close(4001, 'auth timeout')
      }, AUTH_TIMEOUT_MS)
      authTimer.unref()
      this.authTimers.set(socket, authTimer)

      const connection: RemoteConnection = {
        isOpen: true,
        send: (message: RemoteServerMessage): void => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message))
          }
        },
      }
      this.connections.set(socket, connection)
      this.options.bridge.attachConnection(connection)

      socket.on('message', (data: Buffer) => {
        this.handleMessage(socket, data, {
          isAuthenticated: () => authenticated,
          markAuthenticated: (): void => {
            authenticated = true
          },
        })
      })

      socket.on('error', (error: Error) => {
        this.options.logger?.warn('remote client socket error', {
          message: error.message,
        })
      })

      socket.on('close', () => {
        const timer = this.authTimers.get(socket)
        if (timer !== undefined) clearTimeout(timer)
        this.authTimers.delete(socket)
        this.sockets.delete(socket)
        const active = this.connections.get(socket)
        if (active !== undefined) {
          this.connections.delete(socket)
          this.options.bridge.detachConnection(active)
        }
        this.options.logger?.info('remote client disconnected', {
          clientCount: this.sockets.size,
        })
      })
    })
  }

  /** Number of currently connected (and authenticated) sockets. */
  get clientCount(): number {
    return this.connections.size
  }

  async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.httpServer.off('error', onError)
        resolve()
      }
      this.httpServer.once('error', onError)
      this.httpServer.once('listening', onListening)
      this.httpServer.listen(port, '0.0.0.0')
    })
    this.startHeartbeat()
    this.options.logger?.info('remote server listening', { port })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    for (const socket of this.sockets) {
      socket.close(1001, 'server shutting down')
    }
    this.sockets.clear()
    this.connections.clear()
    this.authTimers.clear()
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => resolve())
      })
    })
  }

  /** Push the current service state to every connected client. */
  broadcastState(): void {
    this.broadcast({ type: 'server-state', state: this.options.getState() })
  }

  private startHeartbeat(): void {
    const timer = setInterval(() => {
      for (const socket of this.sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
    timer.unref()
    this.heartbeatTimer = timer
  }

  private broadcast(message: RemoteServerMessage): void {
    for (const connection of this.connections.values()) {
      connection.send(message)
    }
  }

  private handleMessage(
    socket: WebSocket,
    data: Buffer,
    state: {
      readonly isAuthenticated: () => boolean
      readonly markAuthenticated: () => void
    },
  ): void {
    let message: RemoteClientMessage
    try {
      message = JSON.parse(data.toString('utf8')) as RemoteClientMessage
    } catch {
      socket.close(1007, 'invalid JSON')
      return
    }

    if (!state.isAuthenticated()) {
      if (message.type !== 'auth') {
        socket.close(4001, 'auth required')
        return
      }
      this.authenticate(socket, message.token)
        .then((ok) => {
          if (ok) state.markAuthenticated()
        })
        .catch(() => socket.close(4002, 'auth failed'))
      return
    }

    switch (message.type) {
      case 'request':
        void this.handleRequest(socket, message).catch((error: unknown) => {
          const errorText = error instanceof Error ? error.message : String(error)
          socket.send(
            JSON.stringify({
              type: 'response',
              id: message.id,
              ok: false,
              error: errorText,
            } satisfies RemoteServerMessage),
          )
        })
        break
      case 'approval':
        if (!this.options.hub.respondApproval(message.requestId, message.response)) {
          socket.send(
            JSON.stringify({
              type: 'settled',
              sessionId: '',
              requestId: message.requestId,
            } satisfies RemoteServerMessage),
          )
        }
        break
      case 'question':
        if (!this.options.hub.respondQuestion(message.requestId, message.result)) {
          socket.send(
            JSON.stringify({
              type: 'settled',
              sessionId: '',
              requestId: message.requestId,
            } satisfies RemoteServerMessage),
          )
        }
        break
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong', t: message.t } satisfies RemoteServerMessage))
        break
      default:
        // Unknown client message types are ignored (forward-compatible).
        break
    }
  }

  private async authenticate(socket: WebSocket, token: string): Promise<boolean> {
    if (token.length === 0 || token !== this.options.getToken()) {
      this.recordFailedAuth()
      socket.close(4001, 'invalid token')
      return false
    }
    socket.send(
      JSON.stringify({
        type: 'auth-ok',
        state: this.options.getState(),
      } satisfies RemoteServerMessage),
    )
    return true
  }

  private recordFailedAuth(): void {
    const now = Date.now()
    this.failedAuthTimes.push(now)
    this.failedAuthTimes = this.failedAuthTimes.filter(
      (t) => now - t < FAILED_AUTH_WINDOW_MS,
    )
    if (this.failedAuthTimes.length > FAILED_AUTH_LIMIT) {
      this.options.logger?.warn('remote auth failures exceed rate limit', {
        count: this.failedAuthTimes.length,
      })
    }
  }

  private async handleRequest(
    socket: WebSocket,
    message: RemoteRequestMessage,
  ): Promise<void> {
    const result = await this.options.bridge.invoke(message.method as never, message.params)
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'response',
          id: message.id,
          ok: true,
          result,
        } satisfies RemoteServerMessage),
      )
    }
  }
}
