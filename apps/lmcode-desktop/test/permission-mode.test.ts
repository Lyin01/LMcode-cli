import { describe, expect, it } from 'vitest'
import { isPermissionMode, nextPermissionMode } from '../src/shared/permission-mode'

describe('permission mode keyboard cycle', () => {
  it('cycles manual, auto, and yolo in order', () => {
    expect(nextPermissionMode('manual')).toBe('auto')
    expect(nextPermissionMode('auto')).toBe('yolo')
    expect(nextPermissionMode('yolo')).toBe('manual')
  })

  it('rejects untrusted values and recovers to manual', () => {
    expect(isPermissionMode('auto')).toBe(true)
    expect(isPermissionMode('unrestricted')).toBe(false)
    expect(nextPermissionMode('untrusted')).toBe('manual')
  })
})
