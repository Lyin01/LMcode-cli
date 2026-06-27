import type { Message, ToolCallInfo } from '@/types'

/**
 * Map the SDK's persisted conversation history (`session.getContext().history`,
 * an array of ltod `Message` objects) into the renderer's flat `Message[]` used
 * for display. Mirrors how `session-store.handleEvent` builds messages from the
 * live event stream.
 */
export function historyToMessages(history: unknown[]): Message[] {
  const out: Message[] = []
  let counter = 0
  const nextId = () => `hist_${counter++}`

  for (const raw of history) {
    const m = raw as {
      role?: string
      content?: Array<{ type?: string; text?: string; think?: string }>
      toolCalls?: Array<{ id?: string; name?: string; arguments?: string | null }>
      toolCallId?: string
      origin?: { kind?: string }
    }
    const parts = Array.isArray(m.content) ? m.content : []
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('')
    const thinking = parts.filter((p) => p.type === 'think').map((p) => p.think ?? '').join('')

    if (m.role === 'user') {
      // Only real user prompts. Injected system reminders / tool notifications /
      // background-task wakes carry a non-"user" origin — keep them out of the UI.
      const isRealUser = !m.origin || m.origin.kind === 'user'
      if (isRealUser && text.trim()) {
        out.push({ id: nextId(), role: 'user', content: text, timestamp: 0 })
      }
    } else if (m.role === 'assistant') {
      const toolCalls: ToolCallInfo[] = (m.toolCalls ?? []).map((tc) => ({
        id: tc.id ?? nextId(),
        toolName: tc.name ?? '',
        args: tc.arguments ?? '',
        status: 'completed' as const,
      }))
      if (text.trim() || thinking.trim() || toolCalls.length > 0) {
        out.push({
          id: nextId(),
          role: 'assistant',
          content: text,
          timestamp: 0,
          ...(thinking.trim() ? { thinking, thinkingState: 'complete' as const } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        })
      }
    } else if (m.role === 'tool') {
      // Attach the tool result to the matching call on the latest assistant turn.
      for (let i = out.length - 1; i >= 0; i--) {
        const prev = out[i]!
        if (prev.role === 'assistant' && prev.toolCalls) {
          const tc = prev.toolCalls.find((t) => t.id === m.toolCallId)
          if (tc) {
            tc.result = text
            break
          }
        }
      }
    }
    // 'system' messages are internal scaffolding — skip.
  }

  return out
}
