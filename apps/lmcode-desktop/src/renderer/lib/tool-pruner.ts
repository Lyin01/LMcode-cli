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
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) i++
    }
    count++
  }
  return count
}

/** Slice `[start, end)` in Unicode code points without allocating an array of the whole string. */
export function sliceCodePoints(text: string, start: number, end: number): string {
  if (end <= start || start >= text.length) return ''
  let i = 0
  let seen = 0
  while (i < text.length && seen < start) {
    const code = text.codePointAt(i)!
    i += code > 0xffff ? 2 : 1
    seen++
  }
  const from = i
  while (i < text.length && seen < end) {
    const code = text.codePointAt(i)!
    i += code > 0xffff ? 2 : 1
    seen++
  }
  return text.slice(from, i)
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

  // UTF-16 length is an upper bound on code-point length. Skip the full
  // scan (and the previous Array.from of the whole string) when the
  // output cannot possibly exceed the prune threshold.
  if (rawContent.length <= threshold) {
    return {
      isPruned: false,
      displayContent: rawContent,
      rawContent,
      totalChars: codePointLength(rawContent),
      prunedChars: 0,
      totalLines: rawContent.split('\n').length,
    }
  }

  const totalChars = codePointLength(rawContent)
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

  const headText = sliceCodePoints(rawContent, 0, headEnd)
  const tailText = sliceCodePoints(rawContent, tailStart, totalChars)

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
