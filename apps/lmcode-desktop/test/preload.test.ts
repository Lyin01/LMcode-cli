import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send,
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('desktop preload bridge', () => {
  it('exposes only the narrow lmcode API and acknowledges dialog responses', async () => {
    await import('../src/preload/index')

    expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith('lmcodeAPI', expect.any(Object))

    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as {
      exportSession(id: string): Promise<string>
      onInteractionSettled(callback: (payload: unknown) => void): () => void
      respondApproval(payload: unknown): Promise<void>
      respondQuestion(payload: unknown): Promise<void>
    }
    const approval = { requestId: 'approval-1', response: { decision: 'cancelled' } }
    const question = { requestId: 'question-1', result: null }

    await api.exportSession('session-1')
    await api.respondApproval(approval)
    await api.respondQuestion(question)

    const onSettled = vi.fn()
    const unsubscribe = api.onInteractionSettled(onSettled)
    const listener = electron.on.mock.calls.find(
      ([channel]) => channel === 'lmcode:interactionSettled',
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
    const settledPayload = { sessionId: 'session-1', requestId: 'approval-1' }
    listener?.({}, settledPayload)
    unsubscribe()

    expect(electron.invoke).toHaveBeenCalledWith('lmcode:exportSession', 'session-1')
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:respondApproval', approval)
    expect(electron.invoke).toHaveBeenCalledWith('lmcode:respondQuestion', question)
    expect(onSettled).toHaveBeenCalledWith(settledPayload)
    expect(electron.removeListener).toHaveBeenCalledWith('lmcode:interactionSettled', listener)
    expect(electron.send).not.toHaveBeenCalled()
  })
})
