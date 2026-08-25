import { describe, expect, it } from 'vitest'
import {
  fileBasename,
  fileUrlToLocalPath,
  isSafeExternalHref,
  resolveHrefOpenTarget,
  resolveOpenTarget,
} from '../src/renderer/lib/open-target'

describe('output file open targets', () => {
  it('does not treat UNC shares as openable local files', () => {
    expect(resolveOpenTarget('\\\\evil\\share\\notes.txt')).toBeNull()
  })

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
    expect(resolveOpenTarget('e.g.', 'E:\\workspace')).toBeNull()
    expect(resolveOpenTarget('i.e.', 'E:\\workspace')).toBeNull()
    expect(resolveOpenTarget('etc.', 'E:\\workspace')).toBeNull()
    expect(resolveOpenTarget('v1.0', 'E:\\workspace')).toBeNull()
  })

  it('resolves markdown hrefs to local HTML and ignores web links', () => {
    expect(resolveHrefOpenTarget('burning-letter.html', 'E:\\workspace')).toBe(
      'E:\\workspace\\burning-letter.html',
    )
    expect(resolveHrefOpenTarget('./out/index.html', 'E:\\workspace')).toBe(
      'E:\\workspace\\out\\index.html',
    )
    expect(resolveHrefOpenTarget('file:///C:/Users/me/out.html')).toBe('C:/Users/me/out.html')
    expect(resolveHrefOpenTarget('https://example.com/a.html', 'E:\\workspace')).toBeNull()
    expect(resolveHrefOpenTarget('#section', 'E:\\workspace')).toBeNull()
    expect(fileBasename('E:\\workspace\\burning-letter.html')).toBe('burning-letter.html')
  })

  it('only treats http(s) URLs as external browser targets', () => {
    expect(isSafeExternalHref('https://example.com/a')).toBe(true)
    expect(isSafeExternalHref('http://192.168.1.8:37991')).toBe(false)
    expect(isSafeExternalHref('https://user:secret@example.com/a')).toBe(false)
    expect(isSafeExternalHref('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalHref('file:///C:/secret.txt')).toBe(false)
    expect(isSafeExternalHref('data:text/html,hi')).toBe(false)
  })
})
