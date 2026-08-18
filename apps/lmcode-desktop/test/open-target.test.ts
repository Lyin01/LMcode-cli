import { describe, expect, it } from 'vitest'
import { fileUrlToLocalPath, resolveOpenTarget } from '../src/renderer/lib/open-target'

describe('output file open targets', () => {
  it('keeps absolute paths and decodes file URLs', () => {
    expect(resolveOpenTarget('E:/repo/output.html')).toBe('E:/repo/output.html')
    expect(fileUrlToLocalPath('file:///C:/Users/me/output.html')).toBe('C:/Users/me/output.html')
  })

  it('resolves relative output files against the active session directory', () => {
    expect(resolveOpenTarget('output/profile.html', 'E:\\workspace\\site')).toBe(
      'E:\\workspace\\site\\output\\profile.html',
    )
    expect(resolveOpenTarget('../profile.html', 'E:\\workspace\\site')).toBe(
      'E:\\workspace\\profile.html',
    )
    expect(resolveOpenTarget('profile.html', '/workspace/site')).toBe('/workspace/site/profile.html')
  })

  it('normalizes Git Bash drive paths when the session uses a Windows directory', () => {
    expect(resolveOpenTarget('/c/Users/me/profile.html', 'E:\\workspace')).toBe(
      'C:\\Users\\me\\profile.html',
    )
  })

  it('does not turn arbitrary inline code into a file action', () => {
    expect(resolveOpenTarget('npm test', 'E:\\workspace')).toBeNull()
    expect(resolveOpenTarget('profile.html')).toBeNull()
  })
})
