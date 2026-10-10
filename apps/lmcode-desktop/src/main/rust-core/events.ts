/**
 * Translate app-server notifications into the event objects the renderer
 * already reduces. Turn ids on the wire are strings; the renderer counts turns
 * with numbers.
 */

export interface TranslateState {
  nextTurn: number
  readonly turnNumbers: Map<string, number>
  readonly openToolIds: string[]
  readonly openToolNames: string[]
  toolSeq: number
}

export function createTranslateState(): TranslateState {
  return {
    nextTurn: 0,
    turnNumbers: new Map(),
    openToolIds: [],
    openToolNames: [],
    toolSeq: 0,
  }
}

export interface ApprovalView {
  readonly turnId: number
  readonly toolCallId: string
  readonly toolName: string
  readonly action: string
  readonly display:
    | { readonly kind: 'command'; readonly command: string; readonly cwd?: string }
    | { readonly kind: 'generic'; readonly summary: string }
}

export interface QuestionView {
  readonly turnId: number
  readonly questions: ReadonlyArray<{
    readonly question: string
    readonly header?: string
    readonly multiSelect?: boolean
    readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  }>
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function turnNumber(state: TranslateState, serverTurnId: string): number {
  const existing = state.turnNumbers.get(serverTurnId)
  if (existing !== undefined) return existing
  state.nextTurn += 1
  state.turnNumbers.set(serverTurnId, state.nextTurn)
  return state.nextTurn
}

function stamp(sessionId: string, event: Record<string, unknown>): Record<string, unknown> {
  return { ...event, agentId: 'main', sessionId }
}

function endReason(status: string): 'completed' | 'cancelled' | 'failed' {
  if (status === 'interrupted') return 'cancelled'
  if (status === 'failed') return 'failed'
  return 'completed'
}

function rememberTool(state: TranslateState, name: string): string {
  state.toolSeq += 1
  const id = `tool_${state.toolSeq}`
  state.openToolIds.push(id)
  state.openToolNames.push(name)
  return id
}

function takeTool(state: TranslateState, name: string): string {
  const index = state.openToolNames.lastIndexOf(name)
  if (index < 0) return rememberTool(state, name)
  const id = state.openToolIds[index] ?? rememberTool(state, name)
  state.openToolIds.splice(index, 1)
  state.openToolNames.splice(index, 1)
  return id
}

function parseArgs(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText) as unknown
  } catch {
    return argumentsText
  }
}

/** One server notification, or undefined when the renderer has no matching event. */
export function translateNotification(
  method: string,
  params: unknown,
  state: TranslateState,
  sessionId: string,
): Record<string, unknown> | undefined {
  const body = asRecord(params)
  const serverTurnId = asString(body['turnId'])
  const turnId = serverTurnId.length > 0 ? turnNumber(state, serverTurnId) : state.nextTurn
  if (method === 'turn/started') {
    return stamp(sessionId, { type: 'turn.started', turnId, origin: { kind: 'user' } })
  }
  if (method === 'item/agentMessage/delta') {
    return stamp(sessionId, { type: 'assistant.delta', turnId, delta: asString(body['delta']) })
  }
  if (method === 'item/reasoning/delta') {
    return stamp(sessionId, { type: 'thinking.delta', turnId, delta: asString(body['delta']) })
  }
  if (method === 'item/tool/started') {
    const name = asString(body['tool'])
    const argumentsText = asString(body['arguments'])
    return stamp(sessionId, {
      type: 'tool.call.started',
      turnId,
      toolCallId: rememberTool(state, name),
      name,
      args: parseArgs(argumentsText),
    })
  }
  if (method === 'item/tool/completed') {
    const name = asString(body['tool'])
    const ok = body['ok'] !== false
    return stamp(sessionId, {
      type: 'tool.result',
      turnId,
      toolCallId: takeTool(state, name),
      output: asString(body['result']),
      isError: !ok,
    })
  }
  if (method === 'turn/notice') {
    return stamp(sessionId, { type: 'warning', message: asString(body['message']) })
  }
  if (method === 'turn/completed') {
    const status = asString(body['status'])
    const errorText = asString(body['error'])
    return stamp(sessionId, {
      type: 'turn.ended',
      turnId,
      reason: endReason(status),
      error: errorText.length === 0
        ? undefined
        : { code: 'UNKNOWN', message: errorText, retryable: false },
    })
  }
  return undefined
}

function commandFromArguments(argumentsText: string): string {
  const parsed = parseArgs(argumentsText)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const command = (parsed as Record<string, unknown>)['command']
    if (typeof command === 'string' && command.length > 0) return command
  }
  return argumentsText
}

export function approvalFromReverse(params: unknown, state: TranslateState): ApprovalView {
  const body = asRecord(params)
  const tool = asString(body['tool'])
  const argumentsText = asString(body['arguments'])
  const serverTurnId = asString(body['turnId'])
  const turnId = serverTurnId.length > 0 ? turnNumber(state, serverTurnId) : state.nextTurn
  const bash = tool === 'Bash' || tool === 'bash'
  const display = bash
    ? { kind: 'command' as const, command: commandFromArguments(argumentsText) }
    : { kind: 'generic' as const, summary: `${tool} ${argumentsText}`.trim() }
  return {
    turnId,
    toolCallId: `approval_${serverTurnId || tool}`,
    toolName: tool,
    action: tool,
    display,
  }
}

export function questionFromReverse(params: unknown, state: TranslateState): QuestionView {
  const body = asRecord(params)
  const serverTurnId = asString(body['turnId'])
  const turnId = serverTurnId.length > 0 ? turnNumber(state, serverTurnId) : state.nextTurn
  const rawQuestions = Array.isArray(body['questions']) ? body['questions'] : []
  const questions = rawQuestions.map((item) => {
    const question = asRecord(item)
    const options = Array.isArray(question['options']) ? question['options'] : []
    return {
      question: asString(question['question']),
      header: asString(question['header']) || undefined,
      multiSelect: question['multiSelect'] === true,
      options: options.map((option) => {
        const row = asRecord(option)
        return {
          label: asString(row['label']),
          description: asString(row['description']) || undefined,
        }
      }),
    }
  })
  return { turnId, questions }
}

/** Text the turn protocol can carry. Image parts stay out of the wire text. */
export function promptToText(input: unknown): string {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  const text = input
    .map((part) => {
      const row = asRecord(part)
      if (row['type'] === 'text' || typeof row['text'] === 'string') return asString(row['text'])
      return ''
    })
    .join('')
  if (text.trim().length > 0) return text
  const hasImage = input.some((part) => asRecord(part)['type'] === 'image_url')
  return hasImage ? '[image attachment]' : text
}
