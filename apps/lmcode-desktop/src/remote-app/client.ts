import type {
  ApprovalResponse,
  QuestionResult,
} from '@lmcode-cli/lmcode-sdk'
import type {
  RemoteClientMessage,
  RemoteMethod,
  RemoteMethods,
  RemoteServerMessage,
} from '../shared/remote-types'

/**
 * Browser-side client for the desktop remote service.
 *
 * One WebSocket (`/ws`) speaks the protocol in `shared/remote-types.ts`:
 * authenticate with the pairing token, then `request`/`response` RPC plus a
 * pushed event / approval / question stream. Reconnect uses exponential
 * backoff; authentication failures stop retrying and surface `unauthorized`
 * so the page can ask for a fresh token.
 */

export type ConnectionPhase = 'connecting' | 'online' | 'offline' | 'unauthorized'

export interface RemoteClientListener {
  readonly onPhase?: (phase: ConnectionPhase) => void
  readonly onMessage?: (message: RemoteServerMessage) => void
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: number
}

const REQUEST_TIMEOUT_MS = 30_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
/** Close codes the server uses for authentication problems. */
const AUTH_CLOSE_CODES = new Set([4001, 4002, 4003, 4008])

export function remoteSocketUrl(location: {
  readonly protocol: string
  readonly host: string
}): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

export class RemoteClient {
  private socket: WebSocket | null = null
  private phase: ConnectionPhase = 'connecting'
  private readonly listeners = new Set<RemoteClientListener>()
  private readonly pending = new Map<string, PendingRequest>()
  private reconnectAttempt = 0
  private reconnectTimer: number | undefined
  private requestSeq = 0
  private closed = false

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  get currentPhase(): ConnectionPhase {
    return this.phase
  }

  subscribe(listener: RemoteClientListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  connect(): void {
    if (this.closed || this.socket !== null) return
    this.clearReconnectTimer()
    this.setPhase('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      this.setPhase('offline')
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token: this.token } satisfies RemoteClientMessage))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') this.handleRawMessage(event.data)
    })
    socket.addEventListener('close', (event: CloseEvent) => {
      this.handleClose(event)
    })
    socket.addEventListener('error', () => {
      // A close event always follows; reconnect is scheduled there.
    })
  }

  close(): void {
    this.closed = true
    this.clearReconnectTimer()
    this.rejectPending(new Error('连接已关闭'))
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'client closed')
  }

  request<M extends RemoteMethod>(
    method: M,
    params: RemoteMethods[M]['params'],
  ): Promise<RemoteMethods[M]['result']> {
    if (this.phase !== 'online' || this.socket === null) {
      return Promise.reject(new Error('尚未连接到电脑'))
    }
    const id = `req-${(this.requestSeq += 1)}`
    return new Promise<RemoteMethods[M]['result']>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('请求超时，请重试'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          resolve(value as RemoteMethods[M]['result'])
        },
        reject,
        timer,
      })
      this.send({ type: 'request', id, method, params } satisfies RemoteClientMessage)
    })
  }

  respondApproval(requestId: string, response: ApprovalResponse): void {
    this.send({ type: 'approval', requestId, response })
  }

  respondQuestion(requestId: string, result: QuestionResult): void {
    this.send({ type: 'question', requestId, result })
  }

  private send(message: RemoteClientMessage): void {
    const socket = this.socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string') return
    const message = parsed as RemoteServerMessage

    if (message.type === 'auth-ok') {
      this.reconnectAttempt = 0
      this.setPhase('online')
      this.emit(message)
      return
    }
    if (message.type === 'response') {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      window.clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new Error(message.error ?? '请求失败'))
      return
    }
    this.emit(message)
  }

  private handleClose(event: CloseEvent): void {
    this.socket = null
    this.rejectPending(new Error('连接已断开'))
    if (this.closed) return
    if (AUTH_CLOSE_CODES.has(event.code)) {
      this.setPhase('unauthorized')
      return
    }
    this.setPhase('offline')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    for (const listener of this.listeners) listener.onPhase?.(phase)
  }

  private emit(message: RemoteServerMessage): void {
    for (const listener of this.listeners) listener.onMessage?.(message)
  }
}
