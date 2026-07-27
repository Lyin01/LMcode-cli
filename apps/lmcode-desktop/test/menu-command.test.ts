import { describe, expect, it } from 'vitest'
import { findConversationMessageIds } from '../src/renderer/lib/conversation-search'
import { getAdjacentConversationIds } from '../src/renderer/lib/menu-command'
import type { Message, SessionInfo } from '../src/renderer/types'

function session(id: string, updatedAt: number): SessionInfo {
  return {
    id,
    workDir: `C:/${id}`,
    createdAt: updatedAt,
    updatedAt,
    thinkingLevel: 'medium',
    permission: 'manual',
    contextTokens: 0,
    maxContextTokens: 128_000,
    isStreaming: false,
  }
}

describe('desktop menu command helpers', () => {
  it('navigates conversations in the same newest-first order as the sidebar', () => {
    const sessions = [session('older', 10), session('newest', 30), session('middle', 20)]

    expect(getAdjacentConversationIds(sessions, 'middle')).toEqual({
      previousId: 'newest',
      nextId: 'older',
    })
    expect(getAdjacentConversationIds(sessions, 'newest')).toEqual({
      previousId: null,
      nextId: 'middle',
    })
    expect(getAdjacentConversationIds(sessions, 'missing')).toEqual({
      previousId: null,
      nextId: null,
    })
  })

  it('finds rendered conversation text across messages, reasoning, and tool results', () => {
    const messages: Message[] = [
      {
        id: 'user',
        role: 'user',
        content: '检查菜单',
        timestamp: 1,
        attachments: [{ id: 'attachment', kind: 'image', name: 'sidebar.png' }],
      },
      {
        id: 'assistant',
        role: 'assistant',
        content: '已完成',
        thinking: '需要确认侧栏状态',
        timestamp: 2,
        toolCalls: [
          {
            id: 'tool',
            toolName: 'shell_command',
            args: 'pnpm test',
            result: '49 tests passed',
            status: 'completed',
          },
        ],
      },
    ]

    expect(findConversationMessageIds(messages, '菜单')).toEqual(['user'])
    expect(findConversationMessageIds(messages, 'sidebar.png')).toEqual(['user'])
    expect(findConversationMessageIds(messages, '侧栏')).toEqual(['assistant'])
    expect(findConversationMessageIds(messages, '49 TESTS')).toEqual(['assistant'])
    expect(findConversationMessageIds(messages, '   ')).toEqual([])
  })
})
