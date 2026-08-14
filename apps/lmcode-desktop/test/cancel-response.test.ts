import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelResponseSafely } from '@/lib/cancel-response'
import { useSession } from '@/hooks/useSession'
import * as sessionStoreModule from '@/stores/session-store'

const realStore = sessionStoreModule.useSessionStore

describe('cancelResponseSafely', () => {
  it('successful cancellation waits for the API and reports no renderer error', async () => {
    const calls: string[] = []
    const errors: string[] = []
    const result = await cancelResponseSafely('session-success', {
      cancelResponse: async (sessionId) => {
        calls.push(sessionId)
      },
      onError: (message) => errors.push(message),
    })

    expect(result).toEqual({ status: 'cancelled' })
    expect(calls).toEqual(['session-success'])
    expect(errors).toEqual([])
  })

  it('failed cancellation surfaces an error and allows a later retry', async () => {
    const visibleErrors: string[] = []
    const loggedErrors: unknown[] = []
    const expected = new Error('backend still running')
    const failed = await cancelResponseSafely('session-failure', {
      cancelResponse: async () => {
        throw expected
      },
      onError: (message) => visibleErrors.push(message),
      logError: (error) => loggedErrors.push(error),
    })

    expect(failed).toMatchObject({ status: 'failed', error: expected, message: expected.message })
    expect(visibleErrors).toEqual([expected.message])
    expect(loggedErrors).toEqual([expected])

    const retried = await cancelResponseSafely('session-failure', {
      cancelResponse: async () => undefined,
    })
    expect(retried).toEqual({ status: 'cancelled' })
  })

  it('duplicate clicks share the in-flight cancellation instead of issuing another IPC', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    let callCount = 0
    const first = cancelResponseSafely('session-pending', {
      cancelResponse: async () => {
        callCount += 1
        await promise
      },
    })
    const duplicate = await cancelResponseSafely('session-pending', {
      cancelResponse: async () => {
        callCount += 1
      },
    })

    expect(duplicate).toEqual({ status: 'pending' })
    expect(callCount).toBe(1)
    resolve()
    expect(await first).toEqual({ status: 'cancelled' })
  })
})

describe('useSession cancel wiring', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    realStore.setState({
      currentSessionId: 'session-a',
      sessions: [
        {
          id: 'session-a',
          workDir: 'C:/repo-a',
          createdAt: 1,
          updatedAt: 1,
          thinkingLevel: 'medium',
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 1_000,
          isStreaming: true,
        },
      ],
      messages: [],
      isStreaming: true,
      streamStatus: null,
      bg: {},
    })
    // zustand serves the *initial* state as the server snapshot, so a plain
    // renderToStaticMarkup probe would never see the setState above. Route
    // the hook's selector to the live store instead (same pattern as
    // sidebar-accessibility.test.ts).
    vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(
      ((selector) => selector(realStore.getState())) as typeof sessionStoreModule.useSessionStore,
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function captureCancel(): () => Promise<void> {
    let captured: () => Promise<void> = async () => {}
    function Probe() {
      captured = useSession().cancel
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return captured
  }

  it('keeps streaming after a successful cancel until the authoritative turn.ended arrives', async () => {
    const cancelResponse = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { lmcodeAPI: { cancelResponse } })

    await captureCancel()()

    // The IPC succeeded, but only turn.ended may clear streaming — nothing
    // else, including the cancel callback itself.
    expect(cancelResponse).toHaveBeenCalledWith('session-a')
    expect(realStore.getState().isStreaming).toBe(true)
    expect(realStore.getState().messages).toEqual([])

    realStore.getState().handleEvent('session-a', {
      type: 'turn.ended',
      turnId: 1,
      reason: 'cancelled',
      agentId: 'main',
      sessionId: 'session-a',
    })
    const state = realStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.messages.at(-1)).toMatchObject({
      role: 'system',
      variant: 'notice',
      content: '已停止生成',
    })
  })

  it('keeps streaming on failure and appends a visible, retryable error message', async () => {
    const cancelResponse = vi.fn().mockRejectedValue(new Error('backend still running'))
    vi.stubGlobal('window', { lmcodeAPI: { cancelResponse } })

    await captureCancel()()

    const state = realStore.getState()
    expect(state.isStreaming).toBe(true)
    expect(state.messages.at(-1)).toMatchObject({
      role: 'system',
      variant: 'error',
      content: '停止失败：backend still running',
    })
  })
})
