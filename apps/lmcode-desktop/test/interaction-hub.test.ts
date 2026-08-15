import { describe, expect, it, vi } from 'vitest'
import {
  CANCELLED_APPROVAL,
  InteractionHub,
  type InteractionSurface,
} from '../src/main/remote/interaction-hub'

interface Captured {
  sessionId: string
  requestId: string
  payload: unknown
}

function createSurface(name: string): InteractionSurface & { captured: Captured[] } {
  const captured: Captured[] = []
  return {
    name,
    captured,
    sendApproval: vi.fn((payload: { sessionId: string; requestId: string; request: unknown }) => {
      captured.push({ sessionId: payload.sessionId, requestId: payload.requestId, payload: payload.request })
      return true
    }),
    sendQuestion: vi.fn((payload: { sessionId: string; requestId: string; request: unknown }) => {
      captured.push({ sessionId: payload.sessionId, requestId: payload.requestId, payload: payload.request })
      return true
    }),
    notifySettled: vi.fn(),
  }
}

describe('InteractionHub', () => {
  it('broadcasts an approval to every attached surface', async () => {
    const hub = new InteractionHub()
    const renderer = createSurface('renderer')
    const remote = createSurface('remote')
    hub.attachSurface(renderer)
    hub.attachSurface(remote)

    const promise = hub.requestApproval('session-a', { toolCallId: 't1', toolName: 'Bash', action: 'run test', display: { kind: 'generic', summary: 'run test' } })

    expect(renderer.captured).toHaveLength(1)
    expect(remote.captured).toHaveLength(1)
    expect(renderer.captured[0]?.payload).toEqual({
      toolCallId: 't1',
      toolName: 'Bash',
      action: 'run test',
      display: { kind: 'generic', summary: 'run test' },
    })
    expect(remote.captured[0]?.sessionId).toBe('session-a')

    hub.respondApproval(renderer.captured[0]?.requestId ?? '', { decision: 'approved' })
    await expect(promise).resolves.toEqual({ decision: 'approved' })
    expect(renderer.notifySettled).toHaveBeenCalledOnce()
    expect(remote.notifySettled).toHaveBeenCalledOnce()
  })

  it('settles from whichever surface responds first', async () => {
    const hub = new InteractionHub()
    const renderer = createSurface('renderer')
    const remote = createSurface('remote')
    hub.attachSurface(renderer)
    hub.attachSurface(remote)

    const approval = hub.requestApproval('s', { toolCallId: 't1', toolName: 'Bash', action: 'a', display: { kind: 'generic', summary: 'a' } })
    const question = hub.requestQuestion('s', { questions: [] })

    // The same requestId is broadcast to every surface; surface A and B see
    // the approval first, the question second (same wire requestId each time).
    const approvalId = renderer.captured[0]?.requestId ?? ''
    const questionId = renderer.captured[1]?.requestId ?? ''
    hub.respondApproval(approvalId, { decision: 'rejected' })
    hub.respondQuestion(questionId, { answers: { q: '42' } })

    await expect(approval).resolves.toEqual({ decision: 'rejected' })
    await expect(question).resolves.toEqual({ answers: { q: '42' } })
  })

  it('cancels pending requests with defaults when no surface delivers', async () => {
    const hub = new InteractionHub()
    const silent = createSurface('silent')
    ;(silent.sendApproval as ReturnType<typeof vi.fn>).mockReturnValue(false)
    ;(silent.sendQuestion as ReturnType<typeof vi.fn>).mockReturnValue(false)
    hub.attachSurface(silent)

    await expect(hub.requestApproval('s', { toolCallId: 't1', toolName: 'Bash', action: 'a', display: { kind: 'generic', summary: 'a' } })).resolves.toEqual(
      CANCELLED_APPROVAL,
    )
    await expect(hub.requestQuestion('s', { questions: [] })).resolves.toBeNull()
  })

  it('expires unanswered requests with default outcomes', async () => {
    vi.useFakeTimers()
    try {
      const hub = new InteractionHub({ timeoutMs: 500 })
      const renderer = createSurface('renderer')
      hub.attachSurface(renderer)

      const approval = hub.requestApproval('s', { toolCallId: 't1', toolName: 'Bash', action: 'slow', display: { kind: 'generic', summary: 'slow' } })
      const question = hub.requestQuestion('s', { questions: [] })
      await vi.advanceTimersByTimeAsync(600)

      await expect(approval).resolves.toEqual(CANCELLED_APPROVAL)
      await expect(question).resolves.toBeNull()
      expect(renderer.notifySettled).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles all pending interactions for a session', async () => {
    const hub = new InteractionHub()
    const renderer = createSurface('renderer')
    hub.attachSurface(renderer)

    const approval = hub.requestApproval('s1', { toolCallId: 't1', toolName: 'Bash', action: 'a', display: { kind: 'generic', summary: 'a' } })
    const question = hub.requestQuestion('s1', { questions: [] })
    const otherApproval = hub.requestApproval('s2', { toolCallId: 't2', toolName: 'Bash', action: 'b', display: { kind: 'generic', summary: 'b' } })

    hub.settleSession('s1')

    await expect(approval).resolves.toEqual(CANCELLED_APPROVAL)
    await expect(question).resolves.toBeNull()
    // A different session stays pending.
    await expect(
      Promise.race([
        otherApproval.then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
      ]),
    ).resolves.toBe('pending')
    hub.settleAll()
    await expect(otherApproval).resolves.toEqual(CANCELLED_APPROVAL)
  })

  it('rejects a duplicate surface name and allows detach/reattach', () => {
    const hub = new InteractionHub()
    const surface = createSurface('renderer')
    hub.attachSurface(surface)
    expect(() => hub.attachSurface(createSurface('renderer'))).toThrow(/already attached/)
    hub.detachSurface('renderer')
    expect(() => hub.attachSurface(createSurface('renderer'))).not.toThrow()
  })
})
