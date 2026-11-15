const STORAGE_KEY = 'lmcode-sidebar-open'
const COLLAPSED_PROJECTS_KEY = 'lmcode-sidebar-collapsed-projects'
const WIDTH_KEY = 'lmcode-sidebar-width'

export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_DEFAULT_WIDTH = 280

/** Persisted sidebar width, clamped so a stale value can never break layout. */
export function getStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    if (Number.isFinite(parsed)) {
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed))
    }
  } catch {
    // Storage may be unavailable in a hardened renderer.
  }
  return SIDEBAR_DEFAULT_WIDTH
}

export function setStoredSidebarWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
}

export function getStoredSidebarOpen(): boolean {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'false') return false
    if (value === 'true') return true
  } catch {
    // Storage may be unavailable in a hardened renderer.
  }
  return true
}

export function setStoredSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(open))
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
}

/** Project groups the user collapsed in the sidebar session list. */
export function getStoredCollapsedProjects(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    // Storage may be unavailable in a hardened renderer.
    return new Set()
  }
}

export function setStoredCollapsedProjects(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]))
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
}
