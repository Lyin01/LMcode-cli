/**
 * Long-term memory library helpers for the settings panel. A memory record is
 * a task experience, a stable user preference, or a pending task (`kind`);
 * preferences are auto-injected into every session and pending tasks are
 * surfaced in fresh sessions, so the library gives each its own view, badge,
 * and card text.
 */

export type MemoryKind = 'task' | 'preference' | 'pending'
export type MemoryKindFilter = 'all' | MemoryKind

export interface MemoryRecordLike {
  readonly userNeed?: string | undefined
  readonly approach?: string | undefined
  readonly outcome?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly kind?: string | undefined
}

/**
 * Mirrors `normalizeMemoKind` from `@lmcode/memory` without importing it: the
 * renderer bundle must stay free of the store's node-only modules.
 */
export function normalizeMemoryKind(kind: unknown): MemoryKind {
  return kind === 'preference' || kind === 'pending' ? kind : 'task'
}

export interface MemoryKindCounts {
  readonly all: number
  readonly preference: number
  readonly pending: number
  readonly task: number
}

export function countMemoriesByKind(memories: readonly MemoryRecordLike[]): MemoryKindCounts {
  let preference = 0
  let pending = 0
  for (const memory of memories) {
    const kind = normalizeMemoryKind(memory.kind)
    if (kind === 'preference') preference += 1
    else if (kind === 'pending') pending += 1
  }
  return { all: memories.length, preference, pending, task: memories.length - preference - pending }
}

/**
 * Filter by kind and free-text query.
 *
 * The rule text of a preference lives in `approach`, so the query must search
 * it — looking only at userNeed/outcome would make preference rules
 * unfindable once the library grew past a screenful.
 */
export function filterMemories<T extends MemoryRecordLike>(
  memories: readonly T[],
  options: { readonly query?: string; readonly kind?: MemoryKindFilter } = {},
): T[] {
  const kind = options.kind ?? 'all'
  const query = options.query?.trim().toLowerCase() ?? ''
  return memories.filter((memory) => {
    if (kind !== 'all' && normalizeMemoryKind(memory.kind) !== kind) return false
    if (query.length === 0) return true
    const haystack = [memory.userNeed, memory.approach, memory.outcome, ...(memory.tags ?? [])]
    return haystack.some((field) => field?.toLowerCase().includes(query) === true)
  })
}

export interface MemoryDisplay {
  readonly title: string
  readonly detail?: string
}

/**
 * Card text for one record. For a preference the *rule* is the headline (its
 * `userNeed` is only the scene it applies to); for a pending task the task is
 * the headline and the progress so far is the subtitle; for a task experience
 * the need is the headline and the outcome the subtitle.
 */
export function memoryDisplay(memory: MemoryRecordLike): MemoryDisplay {
  if (normalizeMemoryKind(memory.kind) === 'pending') {
    const task = memory.userNeed?.trim() ?? ''
    const progress = memory.approach?.trim() ?? ''
    return {
      title: task.length > 0 ? task : '未完成的任务',
      ...(progress.length > 0 ? { detail: `进度：${progress}` } : {}),
    }
  }
  if (normalizeMemoryKind(memory.kind) === 'preference') {
    const rule = memory.approach?.trim() ?? ''
    const scene = memory.userNeed?.trim() ?? ''
    const title = rule.length > 0 ? rule : scene.length > 0 ? scene : '偏好'
    return {
      title,
      ...(rule.length > 0 && scene.length > 0 && scene !== rule ? { detail: `适用：${scene}` } : {}),
    }
  }
  const need = memory.userNeed?.trim() ?? ''
  const outcome = memory.outcome?.trim() ?? ''
  return {
    title: need.length > 0 ? need : '通用经验',
    ...(outcome.length > 0 ? { detail: outcome } : {}),
  }
}
