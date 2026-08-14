/**
 * Replay-safe and UI-safe tool output pruning utility.
 *
 * Modeled after @deepseek-ai/dsh-compaction-tool-result-pruner.
 * Prevents super-large tool outputs (e.g. gigantic file reads or log dumps)
 * from freezing the React DOM / Markdown renderer while retaining critical
 * head diagnostic context and tail completion information.
 */

export interface ToolPruneConfig {
  readonly thresholdChars?: number
  readonly headChars?: number
  readonly tailChars?: number
}

export interface PruneResult {
  readonly isPruned: boolean
  readonly displayContent: string
  readonly rawContent: string
  readonly totalChars: number
  readonly prunedChars: number
  readonly totalLines: number
}

export const DEFAULT_PRUNE_CONFIG: Required<ToolPruneConfig> = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
}

/**
 * Measures the length of a string in Unicode code points
 * to safely handle multi-byte characters and emoji without splitting surrogate pairs.
 */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) {
    count++
  }
  return count
}

/**
 * Formats byte or character counts into human-readable strings.
 */
export function formatCharCount(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M 字符`
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}k 字符`
  return `${chars} 字符`
}

/**
 * Prunes an over-budget tool output string into a compact Head + Marker + Tail format.
 */
export function pruneToolOutput(
  rawContent: string | undefined | null,
  config: ToolPruneConfig = {},
): PruneResult {
  if (!rawContent) {
    return {
      isPruned: false,
      displayContent: '',
      rawContent: '',
      totalChars: 0,
      prunedChars: 0,
      totalLines: 0,
    }
  }

  const threshold = config.thresholdChars ?? DEFAULT_PRUNE_CONFIG.thresholdChars
  const headBudget = config.headChars ?? DEFAULT_PRUNE_CONFIG.headChars
  const tailBudget = config.tailChars ?? DEFAULT_PRUNE_CONFIG.tailChars

  const points = Array.from(rawContent)
  const totalChars = points.length
  const totalLines = rawContent.split('\n').length

  if (totalChars <= threshold) {
    return {
      isPruned: false,
      displayContent: rawContent,
      rawContent,
      totalChars,
      prunedChars: 0,
      totalLines,
    }
  }

  const headEnd = Math.max(0, Math.min(headBudget, totalChars))
  const tailStart = Math.max(headEnd, totalChars - tailBudget)
  const prunedChars = tailStart - headEnd

  const headText = points.slice(0, headEnd).join('')
  const tailText = points.slice(tailStart).join('')

  const marker = `\n\n--- ✂️ [已自动精简 ${formatCharCount(prunedChars)} / 点击上方按钮可展开查看完整输出] ✂️ ---\n\n`
  const displayContent = `${headText}${marker}${tailText}`

  return {
    isPruned: true,
    displayContent,
    rawContent,
    totalChars,
    prunedChars,
    totalLines,
  }
}
