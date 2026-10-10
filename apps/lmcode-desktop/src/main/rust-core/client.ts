import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { resolveLmBinary } from './binary.js'

interface PendingCall {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export interface RpcHandlers {
  onNotification: (method: string, params: unknown) => void
  onServerRequest: (method: string, params: unknown, id: string) => void
}

/**
 * One `lm app-server` process. Requests are JSON lines on stdin. Notifications
 * have a method and no id. Reverse requests use string ids `server:N`.
 */
export class AppServerClient {
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0
  private buffer = ''
  private closed = false
  private stderr = ''

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: RpcHandlers,
  ) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split(/\r?\n/)
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        this.dispatchLine(trimmed)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4_000)
    })
    child.on('exit', (code) => {
      if (this.closed) return
      this.failAll(new Error(`lm app-server exited (${String(code)})${this.stderrText()}`))
    })
    child.on('error', (error) => {
      this.failAll(error)
    })
  }

  static async start(homeDir: string, handlers: RpcHandlers, binary?: string): Promise<AppServerClient> {
    const program = resolveLmBinary(binary)
    const child = spawn(program, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LMCODE_HOME: homeDir },
    }) as ChildProcessWithoutNullStreams
    const client = new AppServerClient(child, handlers)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new Error(`failed to start lm app-server (${program}): ${error.message}`))
      }
      child.once('error', onError)
      child.once('spawn', () => {
        child.off('error', onError)
        resolve()
      })
    })
    await client.request('initialize', {})
    return client
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('lm app-server is closed'))
    this.nextId += 1
    const id = this.nextId
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.write(`${body}\n`)
    })
  }

  respond(id: string, result: unknown): void {
    this.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
    this.failAll(new Error('lm app-server closed'))
  }

  private write(line: string): void {
    if (this.closed || !this.child.stdin.writable) {
      this.failAll(new Error(`lm app-server is not writable${this.stderrText()}`))
      return
    }
    this.child.stdin.write(line)
  }

  private dispatchLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (message === null || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    const method = record['method']
    const id = record['id']
    if (typeof method === 'string' && typeof id === 'string') {
      this.handlers.onServerRequest(method, record['params'], id)
      return
    }
    if (typeof method === 'string' && id === undefined) {
      this.handlers.onNotification(method, record['params'])
      return
    }
    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (record['error'] !== undefined) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(record['error'])}`))
        return
      }
      pending.resolve(record['result'])
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  capturedStderr(): string {
    return this.stderr.trim()
  }

  private stderrText(): string {
    const trimmed = this.stderr.trim()
    return trimmed.length === 0 ? '' : `\n${trimmed}`
  }
}
