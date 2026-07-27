import { describe, expect, it } from 'vitest'
import { historyToMessages } from '../src/renderer/lib/history'
import { serializeTextAttachmentPart } from '../src/shared/file-types'

describe('desktop conversation history projection', () => {
  it('restores user attachment cards without exposing embedded file contents in the bubble', () => {
    const embeddedText = serializeTextAttachmentPart({
      kind: 'text',
      name: 'notes.md',
      content: 'private implementation details',
      sizeBytes: 30,
      truncated: false,
    })

    const messages = historyToMessages([
      {
        role: 'user',
        origin: { kind: 'user' },
        content: [
          { type: 'text', text: 'Review the screenshot' },
          { type: 'text', text: embeddedText },
          {
            type: 'image_url',
            imageUrl: { id: 'screen.png', url: 'data:image/png;base64,AQID' },
          },
        ],
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'Review the screenshot',
      attachments: [
        {
          kind: 'text',
          name: 'notes.md',
          sizeBytes: 30,
          truncated: false,
        },
        {
          kind: 'image',
          name: 'screen.png',
          previewUrl: 'data:image/png;base64,AQID',
        },
      ],
    })
    expect(messages[0]?.content).not.toContain('private implementation details')
  })

  it('keeps an image-only user turn visible after session resume', () => {
    const messages = historyToMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            imageUrl: { id: 'clipboard.png', url: 'data:image/png;base64,AQID' },
          },
        ],
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: '',
      attachments: [{ kind: 'image', name: 'clipboard.png' }],
    })
  })
})
