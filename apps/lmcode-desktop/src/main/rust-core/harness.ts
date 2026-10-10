import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LmcodeConfig, LmcodeConfigPatch, SessionSummary } from '@lmcode-cli/lmcode-sdk'

import { AppServerClient } from './client.js'
import { RustMemoryStore } from './memory.js'
import { RustSession } from './session.js'
import type { CoreHost, DesktopHarness, DesktopSession, ThreadBinding, ThreadView } from './types.js'

export interface RustHarnessOptions {
  readonly homeDir: string
  readonly configPath: string
  readonly binary?: string
}

/**
 * One app-server process for the whole desktop. It keeps a single active
 * thread, so a call for another session resumes that thread when no turn is
 * running and rejects the call while a turn is in progress.
 */
export class RustHarness implements DesktopHarness, CoreHost {
  readonly homeDir: string
  readonly configPath: string
  private readonly sessions = new Map<string, RustSession>()
  private activeId: string | undefined
  private running = false
  private turnOwner: string | undefined

  private constructor(
    private readonly client: AppServerClient,
    options: RustHarnessOptions,
  ) {
    this.homeDir = options.homeDir
    this.configPath = options.configPath
  }

  static async start(options: RustHarnessOptions): Promise<RustHarness> {
    let harness: RustHarness | undefined
    const client = await AppServerClient.start(options.homeDir, {
      onNotification: (method, params) => harness?.onNotification(method, params),
      onServerRequest: (method, params, id) => {
        void harness?.onServerRequest(method, params, id)
      },
    }, options.binary)
    harness = new RustHarness(client, options)
    return harness
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.request<T>(method, params)
  }

  noteTurnRunning(running: boolean): void {
    this.running = running
    if (!running) this.turnOwner = undefined
  }

  beginTurn(sessionId: string): void {
    if (this.running || this.turnOwner !== undefined) {
      throw new Error('a turn is already running')
    }
    this.turnOwner = sessionId
  }

  async ensureConfigFile(): Promise<void> {
    if (existsSync(this.configPath)) return
    await mkdir(dirname(this.configPath), { recursive: true })
    await this.client.request('config/write', { path: this.configPath, text: '' })
  }

  getConfig(): Promise<LmcodeConfig> {
    return this.client.request<LmcodeConfig>('config/get', { path: this.configPath })
  }

  setConfig(patch: LmcodeConfigPatch): Promise<LmcodeConfig> {
    return this.client.request<LmcodeConfig>('config/patch', { path: this.configPath, patch })
  }

  removeProvider(providerId: string): Promise<LmcodeConfig> {
    return this.client.request<LmcodeConfig>('config/patch', {
      path: this.configPath,
      patch: { providers: { [providerId]: null } },
    })
  }

  removeModel(modelId: string): Promise<LmcodeConfig> {
    return this.client.request<LmcodeConfig>('config/patch', {
      path: this.configPath,
      patch: { models: { [modelId]: null } },
    })
  }

  async createSession(input: {
    readonly workDir: string
    readonly model?: string
    readonly thinking?: string
    readonly permission?: string
  }): Promise<DesktopSession> {
    this.assertIdle()
    let model = input.model
    if (model === undefined || model.trim().length === 0) {
      const config = await this.getConfig()
      model = config.defaultModel ?? 'script'
    }
    const result = await this.client.request<{ thread: ThreadView }>('thread/start', {
      cwd: input.workDir,
      model,
    })
    return this.adopt(result.thread)
  }

  async resumeSession(input: { readonly id: string }): Promise<DesktopSession> {
    const existing = this.sessions.get(input.id)
    if (existing !== undefined && !existing.isClosed) {
      await this.ensureThread(existing)
      return existing
    }
    const listed = await this.client.request<{ threads?: ThreadView[] }>('thread/list', {})
    const thread = (listed.threads ?? []).find((item) => item.id === input.id)
    if (thread === undefined) throw new Error(`Session "${input.id}" not found`)
    const session = RustSession.open(this, thread)
    this.sessions.set(session.id, session)
    await this.ensureThread(session)
    return session
  }

  async forkSession(input: {
    readonly id: string
    readonly workDir: string
    readonly title?: string
    readonly metadata?: unknown
  }): Promise<DesktopSession> {
    this.assertIdle()
    const source = await this.requireKnown(input.id)
    const result = await this.client.request<{ thread: ThreadView }>('thread/fork', {
      cwd: source.workDir,
      threadId: source.id,
      targetCwd: input.workDir,
      title: input.title,
    })
    const forked = RustSession.open(this, result.thread)
    this.sessions.set(forked.id, forked)
    return forked
  }

  async deleteSession(id: string): Promise<void> {
    this.assertIdle()
    const session = await this.requireKnown(id)
    await this.client.request('thread/delete', { cwd: session.workDir, threadId: id })
    session.markClosed()
    this.sessions.delete(id)
    if (this.activeId === id) this.activeId = undefined
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    session?.markClosed()
    this.sessions.delete(id)
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    const listed = await this.client.request<{ threads?: ThreadView[] }>('thread/list', {})
    return (listed.threads ?? []).map((thread) => {
      const known = this.sessions.get(thread.id)
      if (known?.summary !== undefined) {
        known.applyThread(thread)
        return known.summary
      }
      return {
        id: thread.id,
        title: thread.title ?? undefined,
        workDir: thread.cwd,
        sessionDir: thread.sessionDir ?? '',
        createdAt: Date.parse(thread.createdAt ?? '') || Date.now(),
        updatedAt: Date.parse(thread.updatedAt ?? '') || Date.now(),
      }
    })
  }

  async renameSession(input: { readonly id: string; readonly title: string }): Promise<void> {
    this.assertIdle()
    const session = await this.requireKnown(input.id)
    const result = await this.client.request<{ thread: ThreadView }>('thread/rename', {
      cwd: session.workDir,
      threadId: input.id,
      title: input.title,
    })
    session.applyThread(result.thread)
  }

  exportSession(): Promise<{ zipPath: string }> {
    return Promise.reject(new Error('exportSession is not available through lm app-server'))
  }

  memoryStore(): RustMemoryStore {
    return new RustMemoryStore(this.client)
  }

  capturedStderr(): string {
    return this.client.capturedStderr()
  }

  async ensureThread(session: ThreadBinding): Promise<void> {
    if (this.activeId === session.id) return
    if (this.running || (this.turnOwner !== undefined && this.turnOwner !== session.id)) {
      throw new Error('a turn is already running')
    }
    const result = await this.client.request<{ thread: ThreadView }>('thread/resume', {
      cwd: session.workDir,
      threadId: session.id,
    })
    this.activeId = session.id
    session.applyThread(result.thread)
  }

  async reloadThread(session: ThreadBinding): Promise<void> {
    if (this.running && this.activeId === session.id) return
    this.assertIdle()
    const result = await this.client.request<{ thread: ThreadView }>('thread/resume', {
      cwd: session.workDir,
      threadId: session.id,
    })
    this.activeId = session.id
    session.applyThread(result.thread)
  }

  async close(): Promise<void> {
    this.running = false
    this.turnOwner = undefined
    await this.client.close()
  }

  private adopt(thread: ThreadView): RustSession {
    const session = RustSession.open(this, thread)
    this.sessions.set(session.id, session)
    this.activeId = session.id
    return session
  }

  private assertIdle(): void {
    if (this.running || this.turnOwner !== undefined) {
      throw new Error('a turn is already running')
    }
  }

  private async requireKnown(id: string): Promise<RustSession> {
    const existing = this.sessions.get(id)
    if (existing !== undefined) return existing
    await this.resumeSession({ id })
    const resumed = this.sessions.get(id)
    if (resumed === undefined) throw new Error(`Session "${id}" not found`)
    return resumed
  }

  private onNotification(method: string, params: unknown): void {
    const threadId = threadIdOf(params)
    if (method === 'turn/completed') this.noteTurnRunning(false)
    if (method === 'turn/started') this.noteTurnRunning(true)
    if (threadId === undefined) return
    this.sessions.get(threadId)?.handleNotification(method, params)
  }

  private async onServerRequest(method: string, params: unknown, id: string): Promise<void> {
    const threadId = threadIdOf(params)
    const session = threadId === undefined ? undefined : this.sessions.get(threadId)
    try {
      if (method === 'item/commandExecution/requestApproval') {
        const result = session === undefined ? { approved: false } : await session.handleApproval(params)
        this.client.respond(id, result)
        return
      }
      if (method === 'item/tool/requestUserInput') {
        const result = session === undefined ? { answers: null } : await session.handleQuestion(params)
        this.client.respond(id, result)
        return
      }
      this.client.respond(id, { error: `unsupported reverse request ${method}` })
    } catch {
      const fallback = method === 'item/commandExecution/requestApproval'
        ? { approved: false }
        : { answers: null }
      this.client.respond(id, fallback)
    }
  }
}

function threadIdOf(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined
  const value = (params as Record<string, unknown>)['threadId']
  return typeof value === 'string' ? value : undefined
}
