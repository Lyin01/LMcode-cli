import type { Message } from '@/types'

/**
 * No streaming event for this long while a turn is active means the user is
 * staring at a static screen (long tool execution such as post-write
 * validation, or a slow first token). After the threshold we show a heartbeat
 * line so the app never looks frozen.
 */
export const STALL_THRESHOLD_MS = 10_000

/** The tool currently executing, if the latest assistant turn has one. */
export function runningToolName(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const running = message.toolCalls?.find((toolCall) => toolCall.status === 'running')
    return running?.toolName ?? null
  }
  return null
}

export function buildStallNotice(toolName: string | null, elapsedMs: number): string {
  const seconds = Math.max(1, Math.floor(elapsedMs / 1000))
  if (toolName) {
    return `${toolName} 仍在执行…（已 ${seconds} 秒，长时间任务如自动校验属正常）`
  }
  return `仍在等待模型响应…（已 ${seconds} 秒）`
}
