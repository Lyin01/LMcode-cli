import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

const selectWorkDirectory = vi.fn<() => Promise<string | undefined>>()
const createDesktopSession = vi.fn()

describe('desktop project session contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      lmcodeAPI: {
        selectWorkDirectory,
        createSession: createDesktopSession,
      },
    })
    useSessionStore.setState({
      currentSessionId: null,
      sessions: [],
      messages: [],
      isStreaming: false,
      streamStatus: null,
      bg: {},
      pendingInteractions: [],
      thinkingLevel: 'medium',
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates the first chat in an explicitly selected project directory', async () => {
    selectWorkDirectory.mockResolvedValue('C:/repo')
    createDesktopSession.mockResolvedValue({
      id: 'session-project',
      workDir: 'C:/repo',
      sessionDir: 'C:/sessions/session-project',
      createdAt: 1,
      updatedAt: 1,
    })

    await useSessionStore.getState().createSession()

    expect(selectWorkDirectory).toHaveBeenCalledWith(undefined)
    expect(createDesktopSession).toHaveBeenCalledWith({
      workDir: 'C:/repo',
      thinking: 'medium',
    })
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: 'session-project',
      sessions: [expect.objectContaining({ id: 'session-project', workDir: 'C:/repo' })],
    })
  })

  it('does not create a phantom chat when project selection is cancelled', async () => {
    selectWorkDirectory.mockResolvedValue(undefined)

    await useSessionStore.getState().createSession()

    expect(createDesktopSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().currentSessionId).toBeNull()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('clears the active chat atomically when its final persisted session is deleted', () => {
    useSessionStore.setState({
      currentSessionId: 'session-project',
      sessions: [{
        id: 'session-project',
        workDir: 'C:/repo',
        createdAt: 1,
        updatedAt: 1,
        thinkingLevel: 'medium',
        permission: 'manual',
        contextTokens: 10,
        maxContextTokens: 1_000,
        isStreaming: false,
      }],
      messages: [{
        id: 'message-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      }],
      messageQueue: {
        'session-project': [{ id: 'queued-1', text: 'later', createdAt: 1 }],
      },
    })

    useSessionStore.getState().removeDeletedSession('session-project', [])

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: null,
      sessions: [],
      messages: [],
      isStreaming: false,
      messageQueue: {},
    })
  })
})
