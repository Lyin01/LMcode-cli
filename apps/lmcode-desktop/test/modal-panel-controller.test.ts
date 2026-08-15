import { describe, expect, it } from 'vitest'
import { activateModalPanel } from '../src/renderer/lib/modal-panel-controller'

/**
 * Minimal DOM stand-ins: the controller only needs activeElement tracking,
 * listener registration, focus(), contains(), and attribute queries, so the
 * focus-ring contract can be exercised without a browser environment.
 */
class FakeDocument {
  activeElement: FakeElement | null = null
  body = { name: 'body' }
  private readonly listeners = new Map<string, Set<(event: never) => void>>()

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: never): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FakeElement {
  readonly ownerDocument: FakeDocument
  private readonly attributes: Map<string, string>
  focusables: FakeElement[] = []
  isConnected = true
  lastFocusOptions: unknown = null

  constructor(
    readonly name: string,
    ownerDocument: FakeDocument,
    attributes: Record<string, string> = {},
  ) {
    this.ownerDocument = ownerDocument
    this.attributes = new Map(Object.entries(attributes))
  }

  contains(element: FakeElement | null): boolean {
    return element === this || (element !== null && this.focusables.includes(element))
  }

  focus(options?: unknown): void {
    this.ownerDocument.activeElement = this
    this.lastFocusOptions = options ?? null
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  querySelector(selector: string): FakeElement | null {
    if (selector !== '[data-lm-autofocus]') return null
    return this.focusables.find((element) => element.hasAttribute('data-lm-autofocus')) ?? null
  }

  querySelectorAll(): FakeElement[] {
    return this.focusables
  }
}

interface FakeKeyboardEvent {
  readonly key: string
  readonly shiftKey: boolean
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

function keyboardEvent(key: string, shiftKey = false): FakeKeyboardEvent {
  const event: FakeKeyboardEvent = {
    key,
    shiftKey,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.propagationStopped = true
    },
  }
  return event
}

function asPanel(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement
}

function asDocument(documentObject: FakeDocument): Document {
  return documentObject as unknown as Document
}

describe('modal panel controller', () => {
  it('focuses the marked field, traps Tab, closes on Escape, and restores focus', () => {
    const documentObject = new FakeDocument()
    const trigger = new FakeElement('trigger', documentObject)
    const panel = new FakeElement('panel', documentObject)
    const close = new FakeElement('close', documentObject)
    const search = new FakeElement('search', documentObject, { 'data-lm-autofocus': 'true' })
    const outside = new FakeElement('outside', documentObject)
    panel.focusables = [close, search]
    documentObject.activeElement = trigger
    let closeCount = 0

    const dispose = activateModalPanel(asPanel(panel), {
      document: asDocument(documentObject),
      onClose: () => {
        closeCount += 1
      },
    })
    expect(documentObject.activeElement).toBe(search)

    const forward = keyboardEvent('Tab')
    documentObject.dispatch('keydown', forward as never)
    expect(forward.defaultPrevented).toBe(true)
    expect(documentObject.activeElement).toBe(close)

    const backward = keyboardEvent('Tab', true)
    documentObject.dispatch('keydown', backward as never)
    expect(backward.defaultPrevented).toBe(true)
    expect(documentObject.activeElement).toBe(search)

    documentObject.activeElement = outside
    documentObject.dispatch('focusin', { target: outside } as never)
    expect(documentObject.activeElement).toBe(search)

    const escape = keyboardEvent('Escape')
    documentObject.dispatch('keydown', escape as never)
    expect(closeCount).toBe(1)
    expect(escape.defaultPrevented).toBe(true)
    expect(escape.propagationStopped).toBe(true)

    dispose()
    dispose()
    expect(documentObject.activeElement).toBe(trigger)
    expect(trigger.lastFocusOptions).toEqual({ preventScroll: true })
    documentObject.dispatch('keydown', keyboardEvent('Escape') as never)
    expect(closeCount).toBe(1)
  })

  it('uses the panel itself as the initial and fallback focus target when no control is available', () => {
    const documentObject = new FakeDocument()
    const panel = new FakeElement('panel', documentObject)

    const dispose = activateModalPanel(asPanel(panel), { document: asDocument(documentObject) })
    expect(documentObject.activeElement).toBe(panel)

    const tab = keyboardEvent('Tab')
    documentObject.dispatch('keydown', tab as never)
    expect(tab.defaultPrevented).toBe(true)
    expect(documentObject.activeElement).toBe(panel)
    dispose()
  })

  it('does not restore focus to a trigger that was unmounted while the panel was open', () => {
    const documentObject = new FakeDocument()
    const trigger = new FakeElement('trigger', documentObject)
    const panel = new FakeElement('panel', documentObject)
    const button = new FakeElement('button', documentObject)
    panel.focusables = [button]
    documentObject.activeElement = trigger

    const dispose = activateModalPanel(asPanel(panel), { document: asDocument(documentObject) })
    trigger.isConnected = false
    dispose()

    // Focus stays where the panel left it — restoring to a detached trigger
    // would throw focus into the void.
    expect(documentObject.activeElement).toBe(panel)
  })
})
