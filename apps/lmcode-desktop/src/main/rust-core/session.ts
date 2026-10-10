import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  ComputerUseStatus,
  CronJobInfo,
  Event,
  GoalSnapshotData,
  QuestionRequest,
  QuestionResult,
  SessionStatus,
  SessionSummary,
} from '@lmcode-cli/lmcode-sdk'

import {
  approvalFromReverse,
  createTranslateState,
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

function millis(value: string | undefined): number {
  if (value === undefined || value.length === 0) return Date.now()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function toSummary(thread: ThreadView): SessionSummary {
  const title = thread.title ?? undefined
  return {
    id: thread.id,
    title: title === null ? undefined : title,
    workDir: thread.cwd,
    sessionDir: thread.sessionDir ?? '',
    createdAt: millis(thread.createdAt),
    updatedAt: millis(thread.updatedAt),
  }
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

function unsupported(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is not available through lm app-server`))
}

export class RustSession implements DesktopSession, ThreadBinding {
  private closed = false
  private readonly listeners = new Set<(event: Event) => void>()
  private approvalHandler: ((request: ApprovalRequest) => Promise<ApprovalResponse>) | undefined
  private questionHandler: ((request: QuestionRequest) => Promise<QuestionResult>) | undefined
  private readonly translate: TranslateState = createTranslateState()
  private history: unknown[] = []
  summary: SessionSummary | undefined

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
    for (const listener of this.listeners) listener(event as Event)
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
    this.host.beginTurn(this.id)
    try {
      await this.host.ensureThread(this)
      this.host.noteTurnRunning(true)
      await this.host.request('turn/start', { threadId: this.id, text: promptToText(input) })
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
    return {
      model: this.model,
      thinkingLevel: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
    }
  }

  setModel(model: string): Promise<void> {
    return unsupported(`setModel(${model})`)
  }

  setThinking(level: string): Promise<void> {
    return unsupported(`setThinking(${level})`)
  }

  setPermission(mode: string): Promise<void> {
    return unsupported(`setPermission(${mode})`)
  }

  setPlanMode(enabled: boolean): Promise<void> {
    return unsupported(`setPlanMode(${String(enabled)})`)
  }

  async createGoal(objective: string, options?: { readonly replace?: boolean }): Promise<GoalSnapshotData> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ goal: GoalSnapshotData }>('goal/create', {
      objective,
      replace: options?.replace === true,
    })
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
    return result.goal
  }

  async cancelGoal(): Promise<GoalSnapshotData | null> {
    await this.host.ensureThread(this)
    const result = await this.host.request<{ goal: GoalSnapshotData | null }>('goal/cancel', {})
    return result.goal
  }

  compact(): Promise<void> {
    return unsupported('compact')
  }

  undoHistory(count: number): Promise<void> {
    return unsupported(`undoHistory(${String(count)})`)
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

  listBackgroundTasks(): Promise<readonly BackgroundTaskInfo[]> {
    return unsupported('listBackgroundTasks')
  }

  stopBackgroundTask(taskId: string): Promise<void> {
    return unsupported(`stopBackgroundTask(${taskId})`)
  }

  getBackgroundTaskOutput(taskId: string): Promise<string> {
    return unsupported(`getBackgroundTaskOutput(${taskId})`)
  }

  listSkills(): Promise<readonly unknown[]> {
    return unsupported('listSkills')
  }

  activateSkill(name: string): Promise<void> {
    return unsupported(`activateSkill(${name})`)
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
