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

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const STORAGE_KEY = 'lmcode-thinking'
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'medium'

export const THINKING_OPTIONS: ReadonlyArray<{ value: ThinkingEffort; label: string; hint: string }> = [
  { value: 'off', label: '关闭思考', hint: '最快，零思考，直接执行并回答' },
  { value: 'low', label: '低（极速行动）', hint: '轻量推理，极快行动，减少等待' },
  { value: 'medium', label: '中（推荐·均衡）', hint: '速度与质量最佳均衡' },
  { value: 'high', label: '高（深度推理）', hint: '复杂架构与算法排障，耗时较长' },
  { value: 'xhigh', label: '极高', hint: '最强推理，耗时极长' },
  { value: 'max', label: '最大', hint: '允许模型使用最大推理预算' },
]

export function isThinkingEffort(value: string): value is ThinkingEffort {
  return THINKING_OPTIONS.some((option) => option.value === value)
}

export function getStoredThinking(): ThinkingEffort {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && isThinkingEffort(v)) return v
  } catch {
    // ignore (e.g. storage disabled)
  }
  return DEFAULT_THINKING_EFFORT
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
