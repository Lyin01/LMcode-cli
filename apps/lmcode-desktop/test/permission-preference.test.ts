import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

const setPermission = vi.fn(async (): Promise<void> => undefined)

describe('desktop permission preference contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { lmcodeAPI: { setPermission } })
    useSessionStore.setState({
      currentSessionId: 'session-a',
      permission: 'manual',
      sessions: [
        {
          id: 'session-a',
          workDir: 'C:/work',
          createdAt: 1,
          updatedAt: 1,
          thinkingLevel: 'medium',
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 128_000,
          isStreaming: false,
        },
      ],
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('updates the visible session only after the runtime accepts the mode', async () => {
    await useSessionStore.getState().setPermissionPreference('auto')

    const state = useSessionStore.getState()
    expect(setPermission).toHaveBeenCalledWith('session-a', 'auto')
    expect(state.permission).toBe('auto')
    expect(state.sessions[0]?.permission).toBe('auto')
  })

  it('keeps the previous mode when the runtime rejects the change', async () => {
    setPermission.mockRejectedValueOnce(new Error('runtime unavailable'))

    await expect(useSessionStore.getState().setPermissionPreference('yolo')).rejects.toThrow(
      'runtime unavailable',
    )

    const state = useSessionStore.getState()
    expect(state.permission).toBe('manual')
    expect(state.sessions[0]?.permission).toBe('manual')
  })

  it('sets the mode for the next chat without calling a missing runtime session', async () => {
    useSessionStore.setState({ currentSessionId: null, sessions: [] })

    await useSessionStore.getState().setPermissionPreference('auto')

    expect(setPermission).not.toHaveBeenCalled()
    expect(useSessionStore.getState().permission).toBe('auto')
  })
})
