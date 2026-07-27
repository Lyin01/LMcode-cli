import { describe, expect, it } from 'vitest'
import { defaultPastedImageName } from '../src/renderer/lib/pasted-image-name'

describe('defaultPastedImageName', () => {
  const moment = new Date(2026, 6, 17, 21, 45, 30)

  it('builds a timestamped png name by default', () => {
    expect(defaultPastedImageName('image/png', moment)).toBe('pasted-20260717-214530.png')
  })

  it('maps jpeg to the conventional jpg extension', () => {
    expect(defaultPastedImageName('image/jpeg', moment)).toBe('pasted-20260717-214530.jpg')
  })

  it('keeps gif and webp extensions', () => {
    expect(defaultPastedImageName('image/gif', moment)).toBe('pasted-20260717-214530.gif')
    expect(defaultPastedImageName('image/webp', moment)).toBe('pasted-20260717-214530.webp')
  })

  it('falls back to png for unexpected mime types', () => {
    expect(defaultPastedImageName('image/x-unknown', moment)).toBe('pasted-20260717-214530.png')
    expect(defaultPastedImageName('', moment)).toBe('pasted-20260717-214530.png')
  })
})
