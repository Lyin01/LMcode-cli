// Thinking-effort preference for the desktop.
//
// The shared CLI config has `default_thinking = true` with no explicit effort,
// which agent-core resolves to its hardcoded default of "high". On a streaming
// model like deepseek-v4-flash that produces ~25k-token, multi-minute thinking
// blocks *per step* — a complex multi-step task can run 10+ minutes, which is a
// huge window for an app-quit or a stalled stream to kill the turn before the
// closing summary ever arrives. We default the desktop to "medium" so turns
// finish in a sane time, and expose a switcher so power users can dial it back
// up for genuinely hard problems.

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

const STORAGE_KEY = 'lmcode-thinking'
const DEFAULT_EFFORT: ThinkingEffort = 'medium'

export const THINKING_OPTIONS: ReadonlyArray<{ value: ThinkingEffort; label: string; hint: string }> = [
  { value: 'off', label: '关闭思考', hint: '最快，直接回答' },
  { value: 'low', label: '低', hint: '少量推理' },
  { value: 'medium', label: '中（推荐）', hint: '速度与质量均衡' },
  { value: 'high', label: '高', hint: '深度推理，较慢' },
  { value: 'xhigh', label: '极高', hint: '最强推理，最慢' },
]

export function getStoredThinking(): ThinkingEffort {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && THINKING_OPTIONS.some((o) => o.value === v)) return v as ThinkingEffort
  } catch {
    // ignore (e.g. storage disabled)
  }
  return DEFAULT_EFFORT
}

export function setStoredThinking(effort: ThinkingEffort): void {
  try {
    localStorage.setItem(STORAGE_KEY, effort)
  } catch {
    // ignore
  }
}

export function thinkingLabel(effort: ThinkingEffort): string {
  return THINKING_OPTIONS.find((o) => o.value === effort)?.label ?? effort
}
