import { describe, expect, it } from 'vitest'
import {
  requestSessionDeletion,
  SESSION_DELETE_CONFIRMATION_MS,
} from '../src/renderer/lib/session-deletion'

describe('desktop session deletion confirmation', () => {
  it('requires a second request for the same session inside the confirmation window', () => {
    const first = requestSessionDeletion(null, 'session-a', 1_000)

    expect(first).toEqual({
      confirmed: false,
      pending: {
        sessionId: 'session-a',
        expiresAt: 1_000 + SESSION_DELETE_CONFIRMATION_MS,
      },
    })

    const confirmed = requestSessionDeletion(
      first.pending,
      'session-a',
      1_000 + SESSION_DELETE_CONFIRMATION_MS - 1,
    )
    expect(confirmed).toEqual({ confirmed: true, pending: null })
  })

  it('restarts confirmation for another session or after the deadline', () => {
    const first = requestSessionDeletion(null, 'session-a', 1_000)
    const switched = requestSessionDeletion(first.pending, 'session-b', 1_100)
    const expired = requestSessionDeletion(
      first.pending,
      'session-a',
      1_000 + SESSION_DELETE_CONFIRMATION_MS,
    )

    expect(switched).toEqual({
      confirmed: false,
      pending: {
        sessionId: 'session-b',
        expiresAt: 1_100 + SESSION_DELETE_CONFIRMATION_MS,
      },
    })
    expect(expired).toEqual({
      confirmed: false,
      pending: {
        sessionId: 'session-a',
        expiresAt: 1_000 + SESSION_DELETE_CONFIRMATION_MS * 2,
      },
    })
  })
})
