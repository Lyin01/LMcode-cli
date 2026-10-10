import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  ComputerUseStatus,
  CronJobInfo,
  Event,
  GoalSnapshotData,
  QuestionRequest,
  PermissionMode,
  QuestionResult,
  SessionStatus,
  SessionSummary,
} from '@lmcode-cli/lmcode-sdk'

import {
  approvalFromReverse,
  createTranslateState,
  promptParts,
  promptToText,
  questionFromReverse,
  translateNotification,
  type TranslateState,
} from './events.js'
import type { CoreHost, DesktopSession, ThreadBinding, ThreadView } from './types.js'

interface RawCronJob {
  readonly id: string
  readonly cron: string
  readonly prompt: string
  readonly createdAt: number
  readonly recurring?: boolean
  readonly humanSchedule?: string
  readonly nextFireAt?: number | null
  readonly stale?: boolean
  readonly lastFiredAt?: number
}

interface RawMcpServer {
  readonly name: string
  readonly command?: string
  readonly url?: string
  readonly disabled?: boolean
}

interface RawSkill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly source: string
}

interface RawBackgroundTask {
  readonly id: string
  readonly command: string
  readonly description: string
  readonly status: BackgroundTaskInfo['status']
  readonly exitCode?: number | null
  readonly pid?: number | null
  readonly stopReason?: string
  readonly startedAt: number
  readonly finishedAt?: number | null
}

function millis(value: string | undefined): number {
  if (value === undefined || value.length === 0) return Date.now()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function worktreeMetadata(thread: ThreadView): SessionSummary['metadata'] {
  const worktree = thread.desktopWorktree
  if (worktree === undefined || worktree === null) return undefined
  return {
    desktopWorktree: {
      branch: worktree.branch,
      path: worktree.path,
      sourceSessionId: worktree.sourceSessionId,
    },
  }
}

export function toSummary(thread: ThreadView): SessionSummary {
  const title = thread.title ?? undefined
  return {
    id: thread.id,
    title: title === null ? undefined : title,
    workDir: thread.cwd,
    sessionDir: thread.sessionDir ?? '',
    createdAt: millis(thread.createdAt),
    updatedAt: millis(thread.updatedAt),
    metadata: worktreeMetadata(thread),
  }
}

function asPermission(value: string | undefined): PermissionMode {
  if (value === 'yolo' || value === 'manual' || value === 'auto') return value
  return 'manual'
}

function toCronJob(task: RawCronJob): CronJobInfo {
  return {
    id: task.id,
    cron: task.cron,
    humanSchedule: task.humanSchedule ?? task.cron,
    prompt: task.prompt,
    recurring: task.recurring !== false,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextFireAt: task.nextFireAt ?? null,
    stale: task.stale === true,
  }
}

function toMcpServer(row: RawMcpServer): {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly status: 'pending' | 'disabled'
  readonly toolCount: number
  readonly error?: string
} {
  const disabled = row.disabled === true
  return {
    name: row.name,
    transport: row.url === undefined || row.url.length === 0 ? 'stdio' : 'http',
    status: disabled ? 'disabled' : 'pending',
    toolCount: 0,
    error: disabled ? undefined : 'the app-server reads mcp.json and does not spawn MCP servers',
  }
}

function toBackgroundTask(task: RawBackgroundTask): BackgroundTaskInfo {
  return {
    taskId: task.id,
    command: task.command,
    description: task.description,
    status: task.status,
    pid: typeof task.pid === 'number' ? task.pid : 0,
    exitCode: typeof task.exitCode === 'number' ? task.exitCode : null,
    startedAt: task.startedAt,
    endedAt: typeof task.finishedAt === 'number' ? task.finishedAt : null,
    stopReason: task.stopReason,
  }
}

const QUEUED_EVENT_LIMIT = 100

function goalChange(snapshot: GoalSnapshotData | null): {
  readonly kind: 'lifecycle' | 'completion'
  readonly status: string
  readonly reason: string | undefined
  readonly actor: 'user'
} | undefined {
  if (snapshot === null) return undefined
  const reason = typeof snapshot.terminalReason === 'string' ? snapshot.terminalReason : undefined
  if (snapshot.status === 'complete') {
    return { kind: 'completion', status: snapshot.status, reason, actor: 'user' }
  }
  return { kind: 'lifecycle', status: snapshot.status, reason, actor: 'user' }
}

export class RustSession implements DesktopSession, ThreadBinding {
  private closed = false
  private readonly listeners = new Set<(event: Event) => void>()
  /** Notifications that arrived before the desktop subscribed. The first listener drains them. */
  private readonly queued: Event[] = []
  private approvalHandler: ((request: ApprovalRequest) => Promise<ApprovalResponse>) | undefined
  private questionHandler: ((request: QuestionRequest) => Promise<QuestionResult>) | undefined
  private readonly translate: TranslateState = createTranslateState()
  private history: unknown[] = []
  summary: SessionSummary | undefined

  private thinkingLevel = 'off'
  private permissionMode: PermissionMode = 'manual'
  private planMode = false

  private constructor(
    private readonly host: CoreHost,
    readonly id: string,
    readonly workDir: string,
    private model: string,
  ) {}

  static open(host: CoreHost, thread: ThreadView): RustSession {
    const session = new RustSession(host, thread.id, thread.cwd, thread.model ?? 'script')
    session.applyThread(thread)
    return session
  }

  get isClosed(): boolean {
    return this.closed
  }

  applyThread(thread: ThreadView): void {
    this.model = thread.model ?? this.model
    if (typeof thread.thinking === 'string' && thread.thinking.trim().length > 0) {
      this.thinkingLevel = thread.thinking
    }
    if (typeof thread.permission === 'string') {
      this.permissionMode = asPermission(thread.permission)
    }
    if (typeof thread.planMode === 'boolean') {
      this.planMode = thread.planMode
    }
    this.history = Array.isArray(thread.messages) ? thread.messages : this.history
    this.summary = toSummary({ ...thread, messages: undefined })
  }

  markClosed(): void {
    this.closed = true
    this.approvalHandler = undefined
    this.questionHandler = undefined
  }

  onEvent(listener: (event: Event) => void): () => void {
    this.listeners.add(listener)
    const queued = this.queued.splice(0)
    for (const event of queued) listener(event)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setApprovalHandler(handler: ((request: ApprovalRequest) => Promise<ApprovalResponse>) | undefined): void {
    this.approvalHandler = handler
  }

  setQuestionHandler(handler: ((request: QuestionRequest) => Promise<QuestionResult>) | undefined): void {
    this.questionHandler = handler
  }

  handleNotification(method: string, params: unknown): void {
    if (method === 'turn/completed') this.host.noteTurnRunning(false)
    if (method === 'turn/started') this.host.noteTurnRunning(true)
    const event = translateNotification(method, params, this.translate, this.id)
    if (event === undefined) return
    this.publish(event as unknown as Event)
  }

  private publish(event: Event): void {
    if (this.listeners.size === 0) {
      this.queued.push(event)
      if (this.queued.length > QUEUED_EVENT_LIMIT) this.queued.shift()
      return
    }
    for (const listener of this.listeners) listener(event)
  }

  private emitGoal(snapshot: GoalSnapshotData | null): void {
    this.publish({
      type: 'goal.updated',
      snapshot,
      change: goalChange(snapshot),
      agentId: 'main',
      sessionId: this.id,
    } as Event)
  }

  async handleApproval(params: unknown): Promise<{ readonly approved: boolean }> {
    const request = approvalFromReverse(params, this.translate)
    if (this.approvalHandler === undefined) return { approved: false }
    try {
      const response = await this.approvalHandler(request)
      return { approved: response.decision === 'approved' }
    } catch {
      return { approved: false }
    }
  }

  async handleQuestion(params: unknown): Promise<{ readonly answers: unknown }> {
    const request = questionFromReverse(params, this.translate)
    if (this.questionHandler === undefined) return { answers: null }
    try {
      const result = await this.questionHandler(request)
      if (result === null) return { answers: null }
      if (typeof result === 'object' && 'answers' in result) return { answers: result.answers }
      return { answers: result }
    } catch {
      return { answers: null }
    }
  }

  async prompt(input: unknown): Promise<void> {
    const parts = promptParts(input)
    this.host.beginTurn(this.id)
    try {
      await this.host.ensureThread(this)
      this.host.noteTurnRunning(true)
      await this.host.request('turn/start', {
        threadId: this.id,
        text: parts.text,
        images: parts.images,
      })
    } catch (error) {
      this.host.noteTurnRunning(false)
      throw error
    }
  }

  async steer(input: unknown): Promise<void> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ accepted?: boolean }>('turn/steer', { text: promptToText(input) })
    if (result.accepted !== true) throw new Error('steer was not accepted')
  }

  async cancel(): Promise<void> {
    await this.host.request('turn/interrupt', {})
  }

  async getContext(): Promise<{ history: unknown[] }> {
    await this.host.reloadThread(this)
    return { history: this.history }
  }

  getResumeState(): undefined {
    return undefined
  }

  async getStatus(): Promise<SessionStatus> {
    await this.host.ensureThread(this)
    const tokens = await this.host.request<{
      contextTokens?: number
      maxContextTokens?: number
      contextUsage?: number
    }>('thread/status', {})
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      permission: this.permissionMode,
      planMode: this.planMode,
      contextTokens: tokens.contextTokens ?? 0,
      maxContextTokens: tokens.maxContextTokens ?? 0,
      contextUsage: tokens.contextUsage ?? 0,
    }
  }

  async setModel(model: string): Promise<void> {
    const normalized = model.trim()
    if (normalized.length === 0) throw new Error('Session model cannot be empty')
    await this.host.ensureThread(this)
    const result = await this.host.request<{ thread: ThreadView }>('thread/setModel', { model: normalized })
    this.applyThread(result.thread)
  }

  async setThinking(level: string): Promise<void> {
    const normalized = level.trim()
    if (normalized.length === 0) throw new Error('Session thinking level cannot be empty')
    await this.host.ensureThread(this)
    const result = await this.host.request<{ thread: ThreadView }>('thread/setThinking', { level: normalized })
    this.applyThread(result.thread)
  }

  async setPermission(mode: string): Promise<void> {
    if (mode !== 'yolo' && mode !== 'manual' && mode !== 'auto') {
      throw new Error('Session permission mode must be yolo, manual, or auto')
    }
    await this.host.ensureThread(this)
    const result = await this.host.request<{ thread: ThreadView }>('thread/setPermission', { mode })
    this.applyThread(result.thread)
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ thread: ThreadView }>('thread/setPlanMode', { enabled })
    this.applyThread(result.thread)
  }

  async createGoal(objective: string, options?: { readonly replace?: boolean }): Promise<GoalSnapshotData> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ goal: GoalSnapshotData }>('goal/create', {
      objective,
      replace: options?.replace === true,
    })
    this.emitGoal(result.goal)
    return result.goal
  }

  async getGoal(): Promise<{ readonly goal: GoalSnapshotData | null }> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ goal: GoalSnapshotData | null }>('goal/get', {})
    return { goal: result.goal }
  }

  async updateGoalStatus(status: string): Promise<GoalSnapshotData | null> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ goal: GoalSnapshotData | null }>('goal/update', { status })
    this.emitGoal(result.goal)
    return result.goal
  }

  async cancelGoal(): Promise<GoalSnapshotData | null> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ goal: GoalSnapshotData | null }>('goal/cancel', {})
    this.emitGoal(result.goal)
    return result.goal
  }

  async compact(options?: { readonly instruction?: string }): Promise<void> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ thread: ThreadView }>('thread/compact', {
      instruction: options?.instruction,
    })
    this.applyThread(result.thread)
  }

  async undoHistory(count: number): Promise<void> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ thread: ThreadView }>('thread/undo', { count })
    this.applyThread(result.thread)
  }

  async listCronJobs(): Promise<readonly CronJobInfo[]> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ tasks?: RawCronJob[] }>('cron/list', {})
    return (result.tasks ?? []).map(toCronJob)
  }

  async createCronJob(input: { readonly cron: string; readonly prompt: string; readonly recurring?: boolean }): Promise<CronJobInfo> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ task: RawCronJob }>('cron/create', {
      cron: input.cron,
      prompt: input.prompt,
      recurring: input.recurring !== false,
    })
    return toCronJob(result.task)
  }

  async deleteCronJob(id: string): Promise<void> {
    await this.host.ensureThread(this)
    await this.host.request('cron/delete', { id })
  }

  async listBackgroundTasks(options: { readonly activeOnly: boolean }): Promise<readonly BackgroundTaskInfo[]> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ tasks?: RawBackgroundTask[] }>('background/list', {
      activeOnly: options.activeOnly,
    })
    return (result.tasks ?? []).map(toBackgroundTask)
  }

  async stopBackgroundTask(taskId: string, options?: { readonly reason?: string }): Promise<void> {
    await this.host.ensureThread(this)
    await this.host.request('background/stop', { taskId, reason: options?.reason })
  }

  async getBackgroundTaskOutput(taskId: string): Promise<string> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ output?: string }>('background/output', { taskId })
    return result.output ?? ''
  }

  async listSkills(): Promise<readonly unknown[]> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ skills?: RawSkill[] }>('skills/list', {})
    return result.skills ?? []
  }

  async activateSkill(name: string, args?: string): Promise<void> {
    const skillName = name.trim()
    if (skillName.length === 0) throw new Error('Skill name cannot be empty')
    const skillArgs = args?.trim()
    this.host.beginTurn(this.id)
    try {
      await this.host.ensureThread(this)
      this.host.noteTurnRunning(true)
      await this.host.request('skills/activate', {
        name: skillName,
        args: skillArgs === undefined || skillArgs.length === 0 ? undefined : skillArgs,
      })
    } catch (error) {
      this.host.noteTurnRunning(false)
      throw error
    }
  }

  async listMcpServers(): Promise<readonly unknown[]> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ servers?: RawMcpServer[] }>('mcp/list', {})
    return (result.servers ?? []).map(toMcpServer)
  }

  async reconnectMcpServer(name: string): Promise<void> {
    await this.host.ensureThread(this)
    await this.host.request('mcp/reconnect', { name })
  }

  async addMcpServer(name: string, config: unknown): Promise<void> {
    await this.host.ensureThread(this)
    await this.host.request('mcp/add', { name, config })
  }

  async stopMcpServer(name: string): Promise<void> {
    await this.host.ensureThread(this)
    await this.host.request('mcp/stop', { name })
  }

  async removeMcpServer(name: string): Promise<void> {
    await this.host.ensureThread(this)
    await this.host.request('mcp/remove', { name })
  }

  async getComputerUseStatus(): Promise<ComputerUseStatus> {
    await this.host.ensureThread(this)
    return this.host.request<ComputerUseStatus>('computerUse/status', {})
  }

  async setComputerUseEnabled(enabled: boolean): Promise<ComputerUseStatus> {
    await this.host.ensureThread(this)
    return this.host.request<ComputerUseStatus>('computerUse/setEnabled', { enabled })
  }
}
