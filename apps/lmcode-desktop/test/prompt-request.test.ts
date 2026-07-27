import { describe, expect, it } from 'vitest'
import { createDesktopPromptRequest } from '../src/renderer/lib/prompt-request'

describe('desktop renderer prompt request', () => {
  it('preserves path files and pathless clipboard images as distinct attachment sources', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='

    expect(createDesktopPromptRequest('  inspect these  ', [
      {
        id: 'text-1',
        kind: 'text',
        name: 'notes.md',
        filePath: 'C:/work/notes.md',
      },
      {
        id: 'image-1',
        kind: 'image',
        name: 'clipboard.png',
        previewUrl: dataUrl,
      },
    ])).toEqual({
      text: 'inspect these',
      attachments: [
        {
          source: 'path',
          kind: 'text',
          filePath: 'C:/work/notes.md',
        },
        {
          source: 'inline',
          kind: 'image',
          name: 'clipboard.png',
          dataUrl,
        },
      ],
    })
  })

  it('fails visibly instead of silently dropping an attachment with no transferable data', () => {
    expect(() => createDesktopPromptRequest('', [{
      id: 'missing-1',
      kind: 'text',
      name: 'missing.txt',
    }])).toThrow('数据不可用')
  })
})
