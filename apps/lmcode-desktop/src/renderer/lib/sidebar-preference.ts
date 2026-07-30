const STORAGE_KEY = 'lmcode-sidebar-open'

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
