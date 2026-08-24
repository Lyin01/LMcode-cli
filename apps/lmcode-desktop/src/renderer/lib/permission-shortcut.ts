export interface PermissionShortcutEvent {
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly repeat: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

type PermissionShortcutTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

function isInsideModalTarget(target: EventTarget | null | undefined): boolean {
  if (target === null || target === undefined || typeof target !== 'object') return false
  if (!('closest' in target)) return false
  const closest = (target as { closest?: (selector: string) => unknown }).closest
  if (typeof closest !== 'function') return false
  return closest.call(target, '[role="dialog"], [aria-modal="true"]') != null
}

const CAPTURE_OPTIONS = { capture: true } as const

export function handlePermissionModeShortcut(
  event: PermissionShortcutEvent,
  cyclePermission: () => void,
  target?: EventTarget | null,
): boolean {
  if (
    event.key !== 'Tab' ||
    !event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return false
  }

  if (isInsideModalTarget(target)) {
    return false
  }

  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) cyclePermission()
  return true
}

export function registerPermissionModeShortcut(
  target: PermissionShortcutTarget,
  cyclePermission: () => void,
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    handlePermissionModeShortcut(event, cyclePermission, event.target)
  }

  target.addEventListener('keydown', handleKeyDown, CAPTURE_OPTIONS)
  return () => target.removeEventListener('keydown', handleKeyDown, CAPTURE_OPTIONS)
}
