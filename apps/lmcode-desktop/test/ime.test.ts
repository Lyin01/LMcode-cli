import { describe, expect, it } from 'vitest'
import { isImeConfirmKey, noteCompositionEnd } from '../src/renderer/lib/ime'

describe('IME confirm key', () => {
  it('treats composing Enter as an IME confirm, not a send', () => {
    expect(isImeConfirmKey({ isComposing: true })).toBe(true)
    expect(isImeConfirmKey({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(isImeConfirmKey({ keyCode: 229 })).toBe(true)
    expect(isImeConfirmKey({ nativeEvent: { keyCode: 229 } })).toBe(true)
  })

  it('does not block a real Enter after composition has finished', () => {
    expect(isImeConfirmKey({ isComposing: false, keyCode: 13 })).toBe(false)
    expect(isImeConfirmKey({})).toBe(false)
  })

  it('suppresses the Enter that Chromium fires immediately after compositionend', () => {
    noteCompositionEnd()
    expect(isImeConfirmKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true)
    expect(isImeConfirmKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false)
  })
})
