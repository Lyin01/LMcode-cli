import { describe, expect, it, vi } from 'vitest'
import {
  handlePermissionModeShortcut,
  registerPermissionModeShortcut,
  type PermissionShortcutEvent,
} from '../src/renderer/lib/permission-shortcut'

function shortcutEvent(overrides: Partial<PermissionShortcutEvent> = {}): PermissionShortcutEvent {
  return {
    key: 'Tab',
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  }
}

describe('desktop permission shortcut contract', () => {
  it('claims exact Shift+Tab and cycles permission once', () => {
    const event = shortcutEvent()
    const cyclePermission = vi.fn()

    expect(handlePermissionModeShortcut(event, cyclePermission)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(cyclePermission).toHaveBeenCalledOnce()
  })

  it('does not cycle on key repeat or modified Shift+Tab chords', () => {
    const cyclePermission = vi.fn()

    expect(handlePermissionModeShortcut(shortcutEvent({ repeat: true }), cyclePermission)).toBe(true)
    expect(handlePermissionModeShortcut(shortcutEvent({ ctrlKey: true }), cyclePermission)).toBe(false)
    expect(cyclePermission).not.toHaveBeenCalled()
  })

  it('registers one window-level capture listener and removes that same listener', () => {
    let listener: ((event: KeyboardEvent) => void) | undefined
    const addEventListener = vi.fn((
      _type: string,
      nextListener: EventListenerOrEventListenerObject,
    ) => {
      listener = nextListener as (event: KeyboardEvent) => void
    })
    const removeEventListener = vi.fn()
    const target = { addEventListener, removeEventListener } as unknown as Pick<
      Window,
      'addEventListener' | 'removeEventListener'
    >
    const cyclePermission = vi.fn()

    const unregister = registerPermissionModeShortcut(target, cyclePermission)
    expect(addEventListener).toHaveBeenCalledWith('keydown', listener, { capture: true })

    listener?.(shortcutEvent() as unknown as KeyboardEvent)
    expect(cyclePermission).toHaveBeenCalledOnce()

    unregister()
    expect(removeEventListener).toHaveBeenCalledWith('keydown', listener, { capture: true })
  })
})
