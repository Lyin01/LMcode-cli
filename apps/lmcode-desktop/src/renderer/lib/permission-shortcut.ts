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

function queryClosest(target: EventTarget | null | undefined, selector: string): boolean {
  if (target === null || target === undefined || typeof target !== 'object') return false
  if (!('closest' in target)) return false
  const closest = (target as { closest?: (selector: string) => unknown }).closest
  if (typeof closest !== 'function') return false
  return closest.call(target, selector) != null
}

function isInsideModalTarget(target: EventTarget | null | undefined): boolean {
  return queryClosest(target, '[role="dialog"], [aria-modal="true"]')
}

function isPermissionShortcutPassthrough(target: EventTarget | null | undefined): boolean {
  if (queryClosest(target, '[data-lm-composer="true"]')) return false
  return queryClosest(
    target,
    'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="textbox"]',
  )
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

  if (isInsideModalTarget(target) || isPermissionShortcutPassthrough(target)) {
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
