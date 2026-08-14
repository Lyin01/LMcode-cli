/**
 * 会话置顶：本地持久化（localStorage），只影响侧栏排序，不改动会话数据。
 */
const STORAGE_KEY = 'lmcode-pinned-sessions'

function readRaw(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export function getPinnedSessions(): ReadonlySet<string> {
  return new Set(readRaw())
}

export function isSessionPinned(sessionId: string): boolean {
  return readRaw().includes(sessionId)
}

function writeRaw(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为不持久化。
  }
}

export function setSessionPinned(sessionId: string, pinned: boolean): void {
  const current = readRaw()
  const next = pinned
    ? [...current.filter((id) => id !== sessionId), sessionId]
    : current.filter((id) => id !== sessionId)
  writeRaw(next)
}
