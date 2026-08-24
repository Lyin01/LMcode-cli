import { describe, expect, it } from 'vitest'
import type { PendingInteraction } from '../src/shared/ipc-types'
import { visiblePendingInteraction } from '../src/renderer/lib/pending-interaction'

const approvalA: PendingInteraction = {
  kind: 'approval',
  payload: {
    sessionId: 'session-a',
    requestId: 'a1',
    request: {
      toolCallId: 't1',
      toolName: 'Shell',
      action: 'Run',
      display: { kind: 'generic', summary: 'Run' },
    },
  },
}

const questionB: PendingInteraction = {
  kind: 'question',
  payload: {
    sessionId: 'session-b',
    requestId: 'b1',
    request: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] },
  },
}

describe('visiblePendingInteraction', () => {
  it('returns the first request for the session in view, not the global head', () => {
    expect(visiblePendingInteraction([approvalA, questionB], 'session-b')).toBe(questionB)
    expect(visiblePendingInteraction([approvalA, questionB], 'session-a')).toBe(approvalA)
    expect(visiblePendingInteraction([approvalA, questionB], 'session-c')).toBeUndefined()
    expect(visiblePendingInteraction([approvalA, questionB], null)).toBeUndefined()
  })
})
