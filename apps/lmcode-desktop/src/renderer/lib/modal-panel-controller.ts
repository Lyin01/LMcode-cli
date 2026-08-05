/**
 * Focus management for the sidebar drawer dialogs (记忆库 / 扩展).
 *
 * One activation owns everything a modal dialog needs while it is open:
 * initial focus, Escape to close, a Tab/Shift+Tab focus ring, focusin
 * containment (focus that escapes the panel is pulled back in), and focus
 * restoration to the element that was focused before the panel opened.
 *
 * The returned disposer is idempotent and removes every listener; components
 * call it from their effect cleanup. The background is kept reachable via
 * `aria-modal` plus this containment rather than native `inert`, which is
 * still being validated against stacked popovers.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface ModalPanelOptions {
  /** Called when the user presses Escape. */
  readonly onClose?: () => void
  /** Selector for the control that receives initial focus; defaults to `[data-lm-autofocus]`. */
  readonly initialFocusSelector?: string
  /** Document override for tests; defaults to the panel's ownerDocument. */
  readonly document?: Document
}

function focusElement(element: Element | null | undefined): boolean {
  if (!element || typeof (element as HTMLElement).focus !== 'function') return false
  try {
    ;(element as HTMLElement).focus({ preventScroll: true })
  } catch {
    ;(element as HTMLElement).focus()
  }
  return true
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getAttribute('tabindex') !== '-1' &&
      !element.hasAttribute('disabled'),
  )
}

/**
 * Activates modal behavior on an already-mounted panel. Returns the disposer.
 * Throws if the panel is not attached to a document — callers must run this
 * from an effect, after mount.
 */
export function activateModalPanel(
  panel: HTMLElement,
  options: ModalPanelOptions = {},
): () => void {
  const documentObject = options.document ?? panel.ownerDocument
  if (!panel || !documentObject) {
    throw new TypeError('A mounted panel and document are required')
  }

  const previouslyFocused = documentObject.activeElement
  const initialFocusSelector = options.initialFocusSelector ?? '[data-lm-autofocus]'
  let disposed = false

  const focusInitial = (): boolean => {
    const preferred = panel.querySelector<HTMLElement>(initialFocusSelector)
    return focusElement(preferred) || focusElement(panel)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      options.onClose?.()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = focusableElements(panel)
    if (focusable.length === 0) {
      event.preventDefault()
      focusElement(panel)
      return
    }

    const currentIndex = focusable.indexOf(documentObject.activeElement as HTMLElement)
    const nextWraps = !event.shiftKey && (currentIndex < 0 || currentIndex === focusable.length - 1)
    const previousWraps = event.shiftKey && currentIndex <= 0
    if (nextWraps || previousWraps) {
      event.preventDefault()
      focusElement(event.shiftKey ? focusable.at(-1) : focusable[0])
    }
  }

  const onFocusIn = (event: FocusEvent): void => {
    if (!panel.contains(event.target as Node | null)) focusInitial()
  }

  documentObject.addEventListener('keydown', onKeyDown, true)
  documentObject.addEventListener('focusin', onFocusIn, true)
  focusInitial()

  return () => {
    if (disposed) return
    disposed = true
    documentObject.removeEventListener('keydown', onKeyDown, true)
    documentObject.removeEventListener('focusin', onFocusIn, true)
    if (
      previouslyFocused &&
      previouslyFocused !== documentObject.body &&
      previouslyFocused.isConnected !== false
    ) {
      focusElement(previouslyFocused)
    }
  }
}
