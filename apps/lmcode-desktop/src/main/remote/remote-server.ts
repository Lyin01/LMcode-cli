import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
import { REMOTE_WEB_SECURITY_HEADERS, readRemoteWebAsset } from './remote-web.js'
import type { InteractionHub } from './interaction-hub.js'

const MAX_CLIENTS = 16
const MAX_PENDING_AUTH = 8
/** One host cannot hold every pending slot and starve legitimate pairing. */
const MAX_PENDING_AUTH_PER_IP = 2
const AUTH_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 30_000
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
/** Auth frames are a tiny JSON object; reject oversized pre-auth dumps. */
const AUTH_MAX_PAYLOAD_BYTES = 4_096
const FAILED_AUTH_WINDOW_MS = 60_000
const FAILED_AUTH_LIMIT = 10
const CLOSE_DRAIN_MS = 1_500

function rawPayloadBytes(data: Buffer | ArrayBuffer | Buffer[]): number {
  if (Buffer.isBuffer(data)) return data.byteLength
  if (Array.isArray(data)) {
    let total = 0
    for (const chunk of data) total += chunk.byteLength
    return total
  }
  return data.byteLength
}

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
  /**
   * Directory holding the built-in mobile page (`out/remote-app/`). Served on
   * plain HTTP requests so scanning the pairing QR opens a working client.
   */
  readonly webRoot: string
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
  private readonly socketIps = new Map<WebSocket, string>()
  /** Sockets whose last heartbeat ping has not been answered yet. */
  private readonly awaitingPong = new Set<WebSocket>()
  private readonly failedAuthTimesByIp = new Map<string, number[]>()
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(private readonly options: RemoteServerOptions) {
    this.httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res)
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

    this.wss.on('connection', (socket: WebSocket, request?: IncomingMessage) => {
      const ip = request?.socket.remoteAddress ?? 'unknown'
      const pendingAuth = this.sockets.size - this.connections.size
      if (
        this.closed ||
        this.connections.size >= MAX_CLIENTS ||
        pendingAuth >= MAX_PENDING_AUTH ||
        this.pendingAuthCountForIp(ip) >= MAX_PENDING_AUTH_PER_IP
      ) {
        socket.close(1013, 'server busy')
        return
      }
      if (this.isAuthRateLimited(ip)) {
        socket.close(4008, 'too many auth failures')
        return
      }
      this.sockets.add(socket)
      this.socketIps.set(socket, ip)
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
        get isOpen(): boolean {
          return socket.readyState === WebSocket.OPEN
        },
        send: (message: RemoteServerMessage): void => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message))
          }
        },
      }

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        // A socket removed by disconnectAll (token rotation / shutdown) keeps
        // receiving frames until the close handshake finishes. Ignore them so
        // a client that never answers the close frame cannot keep driving the
        // bridge with a revoked token.
        if (!this.sockets.has(socket)) return
        if (!authenticated && rawPayloadBytes(data) > AUTH_MAX_PAYLOAD_BYTES) {
          socket.close(1009, 'auth payload too large')
          return
        }
        this.handleMessage(socket, data, {
          isAuthenticated: () => authenticated,
          markAuthenticated: (): void => {
            if (socket.readyState !== WebSocket.OPEN || !this.sockets.has(socket)) return
            if (this.connections.size >= MAX_CLIENTS) {
              // Pending sockets are admitted below the cap; refuse the ones
              // that would push the authenticated set over it.
              socket.close(1013, 'server busy')
              return
            }
            authenticated = true
            if (!this.connections.has(socket)) {
              this.connections.set(socket, connection)
              this.options.bridge.attachConnection(connection)
            }
          },
        })
      })

      socket.on('pong', () => {
        this.awaitingPong.delete(socket)
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
        this.socketIps.delete(socket)
        this.awaitingPong.delete(socket)
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

  /** Sockets from `ip` that passed the transport checks but have not authenticated. */
  private pendingAuthCountForIp(ip: string): number {
    let count = 0
    for (const socket of this.sockets) {
      if (!this.connections.has(socket) && this.socketIps.get(socket) === ip) count += 1
    }
    return count
  }

  /**
   * Health probe, then the built-in mobile page. Anything that is not a
   * readable file under `webRoot` is a 404 — never a directory listing.
   */
  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.url === '/health' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, name: 'lmcode-desktop-remote' }))
        return
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const asset = await readRemoteWebAsset(this.options.webRoot, request.url ?? '/')
        if (asset !== null) {
          response.writeHead(200, {
            'content-type': asset.contentType,
            ...REMOTE_WEB_SECURITY_HEADERS,
          })
          response.end(request.method === 'HEAD' ? undefined : asset.body)
          return
        }
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('Not found')
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      }
      response.end()
    }
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
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    this.disconnectAll(1001, 'server shutting down', true)
    if (typeof this.httpServer.closeAllConnections === 'function') {
      this.httpServer.closeAllConnections()
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_DRAIN_MS)
      timer.unref()
      this.wss.close(() => {
        this.httpServer.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    })
  }

  /** Drop every socket (authenticated or not). Used when rotating the pairing token. */
  disconnectAll(code: number, reason: string, terminate = false): void {
    for (const timer of this.authTimers.values()) clearTimeout(timer)
    this.authTimers.clear()
    this.socketIps.clear()
    for (const [socket, connection] of this.connections) {
      this.options.bridge.detachConnection(connection)
      this.connections.delete(socket)
    }
    for (const socket of this.sockets) {
      if (terminate) {
        socket.terminate()
        continue
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason)
      }
    }
    this.sockets.clear()
    this.connections.clear()
  }

  /** Push the current service state to every connected client. */
  broadcastState(): void {
    this.broadcast({ type: 'server-state', state: this.options.getState() })
  }

  private startHeartbeat(): void {
    const timer = setInterval(() => {
      for (const socket of this.sockets) {
        if (socket.readyState !== WebSocket.OPEN) {
          this.awaitingPong.delete(socket)
          continue
        }
        if (this.awaitingPong.delete(socket)) {
          // The previous ping was never answered: the client is gone even
          // though the socket still looks open. Reap it instead of feeding
          // the event stream into a dead connection forever.
          socket.terminate()
          continue
        }
        this.awaitingPong.add(socket)
        socket.ping()
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
    data: Buffer | ArrayBuffer | Buffer[],
    state: {
      readonly isAuthenticated: () => boolean
      readonly markAuthenticated: () => void
    },
  ): void {
    let parsed: unknown
    try {
      const raw = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      socket.close(1007, 'invalid JSON')
      return
    }
    if (!isRemoteClientMessage(parsed)) {
      socket.close(1007, 'invalid JSON')
      return
    }
    const message = parsed

    if (!state.isAuthenticated()) {
      if (message.type !== 'auth') {
        socket.close(4001, 'auth required')
        return
      }
      this.authenticate(socket, message.token, this.socketIps.get(socket) ?? 'unknown')
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
        // The validator does not enforce `result` presence; normalize a
        // missing value to `null` (dismissal) exactly like the IPC schema, so
        // `undefined` cannot reach the core's answer normalization.
        if (!this.options.hub.respondQuestion(message.requestId, message.result ?? null)) {
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

  private async authenticate(socket: WebSocket, token: string, ip: string): Promise<boolean> {
    if (this.isAuthRateLimited(ip)) {
      socket.close(4008, 'too many auth failures')
      return false
    }
    if (token.length === 0 || !tokenMatches(token, this.options.getToken())) {
      this.recordFailedAuth(ip)
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

  private pruneFailedAuth(ip: string, now = Date.now()): void {
    const times = this.failedAuthTimesByIp.get(ip)
    if (times === undefined) return
    const next = times.filter((t) => now - t < FAILED_AUTH_WINDOW_MS)
    if (next.length === 0) this.failedAuthTimesByIp.delete(ip)
    else this.failedAuthTimesByIp.set(ip, next)
  }

  private isAuthRateLimited(ip: string): boolean {
    this.pruneFailedAuth(ip)
    return (this.failedAuthTimesByIp.get(ip)?.length ?? 0) >= FAILED_AUTH_LIMIT
  }

  private recordFailedAuth(ip: string): void {
    const now = Date.now()
    this.pruneFailedAuth(ip, now)
    const times = this.failedAuthTimesByIp.get(ip) ?? []
    times.push(now)
    this.failedAuthTimesByIp.set(ip, times)
    if (times.length >= FAILED_AUTH_LIMIT) {
      this.options.logger?.warn('remote auth failures exceed rate limit', {
        count: times.length,
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

function isRemoteClientMessage(value: unknown): value is RemoteClientMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string') return false
  if (type === 'auth') return typeof (value as { token?: unknown }).token === 'string'
  if (type === 'request') {
    return (
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { method?: unknown }).method === 'string'
    )
  }
  if (type === 'approval' || type === 'question') {
    return typeof (value as { requestId?: unknown }).requestId === 'string'
  }
  if (type === 'ping') return typeof (value as { t?: unknown }).t === 'number'
  return false
}

function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) return false
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
