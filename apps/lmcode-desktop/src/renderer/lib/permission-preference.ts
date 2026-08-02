import type { PermissionMode } from '@lmcode-cli/lmcode-sdk'
import { isPermissionMode } from '../../shared/permission-mode'

const STORAGE_KEY = 'lmcode-permission'

export const DEFAULT_PERMISSION_PREFERENCE: PermissionMode = 'manual'

export function getStoredPermissionPreference(): PermissionMode {
  if (typeof window === 'undefined') return DEFAULT_PERMISSION_PREFERENCE
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (isPermissionMode(value)) return value
  } catch {
    // Storage can be unavailable in hardened or test environments.
  }
  return DEFAULT_PERMISSION_PREFERENCE
}

export function setStoredPermissionPreference(permission: PermissionMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, permission)
  } catch {
    // Keep the in-memory preference usable when persistence is unavailable.
  }
}
