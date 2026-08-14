import type { PermissionMode } from '@lmcode-cli/lmcode-sdk'

export const PERMISSION_MODES = ['manual', 'auto', 'yolo'] as const satisfies readonly PermissionMode[]

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.some((mode) => mode === value)
}

export function nextPermissionMode(current: string): PermissionMode {
  switch (current) {
    case 'manual':
      return 'auto'
    case 'auto':
      return 'yolo'
    case 'yolo':
    default:
      return 'manual'
  }
}
