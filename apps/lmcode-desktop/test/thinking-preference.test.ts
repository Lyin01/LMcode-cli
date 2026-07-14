import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THINKING_OPTIONS } from '../src/renderer/lib/thinking'
import { useSessionStore } from '../src/renderer/stores/session-store'

const setThinking = vi.fn(async (): Promise<void> => undefined)
const setItem = vi.fn()

describe('desktop thinking preference contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem,
    })
    vi.stubGlobal('window', { lmcodeAPI: { setThinking } })
    useSessionStore.setState({
      currentSessionId: 'session-a',
      thinkingLevel: 'medium',
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

  it('uses the core-supported off value and updates storage, store, and runtime together', async () => {
    expect(THINKING_OPTIONS.map((option) => option.value)).toContain('off')
    expect(THINKING_OPTIONS.map((option) => option.value)).not.toContain('none')

    await useSessionStore.getState().setThinkingPreference('off')

    const state = useSessionStore.getState()
    expect(setItem).toHaveBeenCalledWith('lmcode-thinking', 'off')
    expect(state.thinkingLevel).toBe('off')
    expect(state.sessions[0]?.thinkingLevel).toBe('off')
    expect(setThinking).toHaveBeenCalledWith('session-a', 'off')
  })

  it('reapplies the same stored preference when the active session changes', async () => {
    useSessionStore.setState({ thinkingLevel: 'xhigh' })

    await useSessionStore.getState().applyThinkingPreference('session-b')

    expect(setThinking).toHaveBeenCalledWith('session-b', 'xhigh')
  })
})
