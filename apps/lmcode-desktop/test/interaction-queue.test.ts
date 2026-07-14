import { beforeEach, describe, expect, it } from 'vitest'
import type { PendingInteraction } from '../src/shared/ipc-types'
import { useSessionStore } from '../src/renderer/stores/session-store'

const approval: PendingInteraction = {
  kind: 'approval',
  payload: {
    sessionId: 'session-a',
    requestId: 'approval-1',
    request: {
      toolCallId: 'tool-1',
      toolName: 'Shell',
      action: 'Run command',
      display: { kind: 'generic', summary: 'Run command' },
    },
  },
}

const question: PendingInteraction = {
  kind: 'question',
  payload: {
    sessionId: 'session-b',
    requestId: 'question-1',
    request: {
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    },
  },
}

describe('desktop interaction queue', () => {
  beforeEach(() => {
    useSessionStore.setState({ pendingInteractions: [] })
  })

  it('preserves FIFO order across approval and question requests', () => {
    const store = useSessionStore.getState()
    store.enqueuePendingInteraction(approval)
    store.enqueuePendingInteraction(question)

    expect(useSessionStore.getState().pendingInteractions).toEqual([approval, question])

    store.completePendingInteraction('question-1')
    expect(useSessionStore.getState().pendingInteractions).toEqual([approval, question])

    store.completePendingInteraction('approval-1')
    expect(useSessionStore.getState().pendingInteractions).toEqual([question])
  })

  it('deduplicates replayed renderer events by request id', () => {
    const store = useSessionStore.getState()
    store.enqueuePendingInteraction(approval)
    store.enqueuePendingInteraction(approval)

    expect(useSessionStore.getState().pendingInteractions).toEqual([approval])
  })

  it('discards an externally settled request even when it is not at the head', () => {
    const store = useSessionStore.getState()
    store.enqueuePendingInteraction(approval)
    store.enqueuePendingInteraction(question)

    store.discardPendingInteraction('question-1')

    expect(useSessionStore.getState().pendingInteractions).toEqual([approval])
  })
})
