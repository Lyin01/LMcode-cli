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
 *
 * Walks UTF-16 code units instead of using `for..of`: the iterator allocates a
 * string per code point, which is the hot path here (every tool result is
 * measured on mount and on every list re-render).
 */
export function codePointLength(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xdc00 && code <= 0xdfff) {
      const previous = text.charCodeAt(index - 1)
      // Low half of a surrogate pair — the high half already counted it.
      if (previous >= 0xd800 && previous <= 0xdbff) continue
    }
    count += 1
  }
  return count
}

/**
 * Line count matching `text.split('\n').length` without allocating the array.
 */
function countLines(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return lines
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
  const totalLines = countLines(rawContent)

  // UTF-16 length is always >= code-point length. If even that larger
  // measure is under budget, skip allocating a code-point array for the
  // common (unpruned) path.
  if (rawContent.length <= threshold) {
    return {
      isPruned: false,
      displayContent: rawContent,
      rawContent,
      totalChars: codePointLength(rawContent),
      prunedChars: 0,
      totalLines,
    }
  }

  const points = Array.from(rawContent)
  const totalChars = points.length

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

/**
 * Results kept by `pruneToolOutputCached` (entries first, then characters).
 * A long conversation holds a few hundred results; bounding the cache keeps
 * memory flat while still absorbing remounts and unrelated list re-renders.
 */
const PRUNE_CACHE_MAX_ENTRIES = 256
const PRUNE_CACHE_MAX_CHARS = 8_000_000

/** Keyed by raw output; values are the same string reference, never a copy. */
const pruneCache = new Map<string, PruneResult>()
let pruneCacheChars = 0

function isDefaultConfig(config: ToolPruneConfig): boolean {
  return (
    config.thresholdChars === undefined &&
    config.headChars === undefined &&
    config.tailChars === undefined
  )
}

/**
 * `pruneToolOutput` with a bounded memo for the default configuration.
 *
 * Tool outputs are immutable strings that get re-measured whenever a row
 * remounts (session switch) or the list re-renders, so identical inputs reuse
 * the previous result instead of walking the same megabytes again. Callers
 * with a custom config bypass the cache to keep the key space honest.
 */
export function pruneToolOutputCached(
  rawContent: string | undefined | null,
  config: ToolPruneConfig = {},
): PruneResult {
  if (!rawContent || !isDefaultConfig(config)) return pruneToolOutput(rawContent, config)

  const hit = pruneCache.get(rawContent)
  if (hit !== undefined) {
    // Refresh insertion order so the hot results survive eviction.
    pruneCache.delete(rawContent)
    pruneCache.set(rawContent, hit)
    return hit
  }

  const result = pruneToolOutput(rawContent)
  pruneCache.set(rawContent, result)
  pruneCacheChars += rawContent.length
  while (
    pruneCache.size > PRUNE_CACHE_MAX_ENTRIES ||
    (pruneCacheChars > PRUNE_CACHE_MAX_CHARS && pruneCache.size > 1)
  ) {
    const oldest = pruneCache.keys().next()
    if (oldest.done === true) break
    const evicted = pruneCache.get(oldest.value)
    pruneCache.delete(oldest.value)
    if (evicted !== undefined) pruneCacheChars -= evicted.rawContent.length
  }
  return result
}

/** Test seam: drops the memo so cases do not leak into each other. */
export function clearPruneCache(): void {
  pruneCache.clear()
  pruneCacheChars = 0
}
