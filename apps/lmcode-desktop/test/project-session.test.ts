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
      model: '',
      thinkingLevel: 'medium',
      permission: 'manual',
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
      model: undefined,
      thinking: 'medium',
      permission: 'manual',
    })
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: 'session-project',
      sessions: [expect.objectContaining({ id: 'session-project', workDir: 'C:/repo' })],
    })
  })

  it('creates a chat directly in a given project without opening the picker', async () => {
    createDesktopSession.mockResolvedValue({
      id: 'session-direct',
      workDir: 'D:/other-repo',
      sessionDir: 'C:/sessions/session-direct',
      createdAt: 2,
      updatedAt: 2,
    })

    await useSessionStore.getState().createSession('D:/other-repo')

    expect(selectWorkDirectory).not.toHaveBeenCalled()
    expect(createDesktopSession).toHaveBeenCalledWith({
      workDir: 'D:/other-repo',
      model: undefined,
      thinking: 'medium',
      permission: 'manual',
    })
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: 'session-direct',
      sessions: [expect.objectContaining({ id: 'session-direct', workDir: 'D:/other-repo' })],
    })
  })

  it('does not create a phantom chat when project selection is cancelled', async () => {
    selectWorkDirectory.mockResolvedValue(undefined)

    await useSessionStore.getState().createSession()

    expect(createDesktopSession).not.toHaveBeenCalled()
    expect(useSessionStore.getState().currentSessionId).toBeNull()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('starts a new chat with the model and permission shown in the composer', async () => {
    useSessionStore.setState({
      model: 'k3',
      thinkingLevel: 'high',
      permission: 'auto',
    })
    createDesktopSession.mockResolvedValue({
      id: 'session-settings',
      workDir: 'C:/repo',
      sessionDir: 'C:/sessions/session-settings',
      createdAt: 3,
      updatedAt: 3,
    })

    await useSessionStore.getState().createSession('C:/repo')

    expect(createDesktopSession).toHaveBeenCalledWith({
      workDir: 'C:/repo',
      model: 'k3',
      thinking: 'high',
      permission: 'auto',
    })
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: 'session-settings',
      model: 'k3',
      thinkingLevel: 'high',
      permission: 'auto',
    })
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
        'session-project': [{ id: 'queued-1', text: 'later', attachments: [], createdAt: 1 }],
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
