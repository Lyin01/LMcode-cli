import { describe, expect, it } from 'vitest'
import {
  filesFromClipboardData,
  shouldCaptureClipboardFiles,
} from '../src/renderer/lib/clipboard-files'

function fakeFile(name: string): File {
  return { name } as File
}

describe('clipboard file capture', () => {
  it('captures explorer copies that include both a file and its path text', () => {
    const file = fakeFile('notes.md')
    const data = {
      files: [file],
      items: [],
    }
    expect(filesFromClipboardData(data)).toEqual([file])
    expect(shouldCaptureClipboardFiles(data)).toBe(true)
  })

  it('falls back to image items when the files list is empty', () => {
    const image = fakeFile('paste.png')
    const data = {
      files: [],
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => image,
        },
      ],
    }
    expect(filesFromClipboardData(data)).toEqual([image])
  })

  it('does not capture a plain text paste', () => {
    const data = { files: [], items: [] }
    expect(filesFromClipboardData(data)).toEqual([])
    expect(shouldCaptureClipboardFiles(data)).toBe(false)
  })
})
