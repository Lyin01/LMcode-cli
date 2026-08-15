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

const CAPTURE_OPTIONS = { capture: true } as const

export function handlePermissionModeShortcut(
  event: PermissionShortcutEvent,
  cyclePermission: () => void,
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
    handlePermissionModeShortcut(event, cyclePermission)
  }

  target.addEventListener('keydown', handleKeyDown, CAPTURE_OPTIONS)
  return () => target.removeEventListener('keydown', handleKeyDown, CAPTURE_OPTIONS)
}
