import { describe, expect, it } from 'vitest'
import { historyToMessages, mergeHydratedHistory } from '../src/renderer/lib/history'
import type { Message } from '../src/renderer/types'
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

  it('restores tool screenshots beside the text result instead of flattening them', () => {
    const messages = historyToMessages([
      {
        role: 'assistant',
        content: [{ type: 'text', text: '已截取桌面' }],
        toolCalls: [{ id: 'call-1', name: 'ComputerUse', arguments: '{"action":"screenshot"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [
          { type: 'text', text: 'screenshot.png' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQID' } },
        ],
      },
    ])

    expect(messages).toHaveLength(1)
    const toolCall = messages[0]?.toolCalls?.[0]
    expect(toolCall).toMatchObject({
      toolName: 'ComputerUse',
      status: 'completed',
      result: 'screenshot.png',
      resultImages: ['data:image/png;base64,AQID'],
    })
    expect(toolCall?.result).not.toContain('base64')
  })

  it('keeps an image-only tool result visible after session resume', () => {
    const messages = historyToMessages([
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'call-9', name: 'ComputerUse', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call-9',
        content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQID' } }],
      },
    ])

    const toolCall = messages[0]?.toolCalls?.[0]
    expect(toolCall?.resultImages).toEqual(['data:image/png;base64,AQID'])
    expect(toolCall?.result).not.toBe('')
    expect(toolCall?.result).not.toContain('data:')
  })
})

describe('mergeHydratedHistory', () => {
  function msg(id: string, role: Message['role'], content: string): Message {
    return { id, role, content, timestamp: 0 }
  }

  it('prepends history when live traffic is a new suffix', () => {
    expect(
      mergeHydratedHistory(
        [msg('h1', 'assistant', 'old')],
        [msg('live', 'user', 'typed during load')],
      ).map((item) => item.id),
    ).toEqual(['h1', 'live'])
  })

  it('drops a history suffix that already arrived live', () => {
    expect(
      mergeHydratedHistory(
        [msg('h1', 'assistant', 'old'), msg('h2', 'user', 'hello')],
        [msg('live', 'user', 'hello')],
      ).map((item) => item.id),
    ).toEqual(['h1', 'live'])
  })

  it('keeps a persisted assistant turn when live still has an empty bubble', () => {
    expect(
      mergeHydratedHistory(
        [msg('h1', 'user', 'hello'), msg('h2', 'assistant', 'full reply')],
        [msg('l1', 'user', 'hello'), msg('l2', 'assistant', '')],
      ).map((item) => item.content),
    ).toEqual(['hello', 'full reply'])
  })

  it('keeps live-only notices after a full overlapping transcript', () => {
    expect(
      mergeHydratedHistory(
        [msg('h1', 'user', 'q'), msg('h2', 'assistant', 'a')],
        [msg('l1', 'user', 'q'), msg('l2', 'assistant', 'a'), msg('l3', 'system', '已停止生成')],
      ).map((item) => item.id),
    ).toEqual(['l1', 'l2', 'l3'])
  })
})
