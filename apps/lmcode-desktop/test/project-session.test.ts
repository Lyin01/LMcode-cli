import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/stores/session-store'

const selectWorkDirectory = vi.fn<() => Promise<string | undefined>>()
const createDesktopSession = vi.fn()
const sendMessage = vi.fn()

describe('desktop project session contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      lmcodeAPI: {
        selectWorkDirectory,
        createSession: createDesktopSession,
        sendMessage,
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
      messageQueue: {},
      model: '',
      thinkingLevel: 'medium',
      permissionPreference: 'manual',
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

  it('creates a no-project session without opening the directory picker', async () => {
    createDesktopSession.mockResolvedValue({
      id: 'session-noproject',
      workDir: 'C:/data/no-project-workspace',
      sessionDir: 'C:/sessions/session-noproject',
      createdAt: 4,
      updatedAt: 4,
    })

    await useSessionStore.getState().createSession(undefined, { noProject: true })

    expect(selectWorkDirectory).not.toHaveBeenCalled()
    expect(createDesktopSession).toHaveBeenCalledWith({
      workDir: undefined,
      noProject: true,
      model: undefined,
      thinking: 'medium',
      permission: 'manual',
    })
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: 'session-noproject',
      sessions: [
        expect.objectContaining({
          id: 'session-noproject',
          workDir: 'C:/data/no-project-workspace',
        }),
      ],
    })
  })

  it('queues the welcome-screen first message only after the session exists, then drains it', async () => {
    const created = Promise.withResolvers<{
      id: string
      workDir: string
      sessionDir: string
      createdAt: number
      updatedAt: number
    }>()
    createDesktopSession.mockReturnValue(created.promise)

    const pending = useSessionStore
      .getState()
      .startSessionWithMessage({ kind: 'no-project' }, '写一首诗')

    // The message must not be queued (and therefore never sent) before the
    // session creation has settled.
    expect(useSessionStore.getState().messageQueue['session-first']).toBeUndefined()
    expect(sendMessage).not.toHaveBeenCalled()

    created.resolve({
      id: 'session-first',
      workDir: 'C:/data/no-project-workspace',
      sessionDir: 'C:/sessions/session-first',
      createdAt: 5,
      updatedAt: 5,
    })
    await pending
    // The store-level queue drain ships the queued first message as soon as
    // the session exists — it no longer waits for a composer to mount.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const state = useSessionStore.getState()
    expect(state.currentSessionId).toBe('session-first')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'session-first',
      expect.objectContaining({ text: '写一首诗' }),
    )
    expect(state.messageQueue['session-first'] ?? []).toEqual([])
    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '写一首诗' }),
    ])
  })

  it('ignores a concurrent startSessionWithMessage while one is already in flight', async () => {
    const created = Promise.withResolvers<{
      id: string
      workDir: string
      sessionDir: string
      createdAt: number
      updatedAt: number
    }>()
    createDesktopSession.mockReturnValue(created.promise)

    const first = useSessionStore
      .getState()
      .startSessionWithMessage({ kind: 'no-project' }, '第一条')
    // A second caller (e.g. a future entry point without a UI `starting`
    // flag) must not race the in-flight creation into two sessions.
    const second = useSessionStore
      .getState()
      .startSessionWithMessage({ kind: 'no-project' }, '第二条')
    await second

    expect(createDesktopSession).toHaveBeenCalledTimes(1)

    created.resolve({
      id: 'session-first',
      workDir: 'C:/data/no-project-workspace',
      sessionDir: 'C:/sessions/session-first',
      createdAt: 5,
      updatedAt: 5,
    })
    await first
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const state = useSessionStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'session-first',
      expect.objectContaining({ text: '第一条' }),
    )

    // The latch releases once creation settles, so a later start works again.
    createDesktopSession.mockResolvedValue({
      id: 'session-second',
      workDir: 'C:/data/no-project-workspace',
      sessionDir: 'C:/sessions/session-second',
      createdAt: 6,
      updatedAt: 6,
    })
    await useSessionStore
      .getState()
      .startSessionWithMessage({ kind: 'no-project' }, '下一轮')
    expect(createDesktopSession).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().currentSessionId).toBe('session-second')
  })

  it('drops the welcome-screen message when session creation fails', async () => {
    createDesktopSession.mockRejectedValue(new Error('harness unavailable'))

    await useSessionStore
      .getState()
      .startSessionWithMessage({ kind: 'project', workDir: 'C:/repo' }, '你好')

    expect(useSessionStore.getState().currentSessionId).toBeNull()
    expect(useSessionStore.getState().messageQueue).toEqual({})
  })

  it('starts a new chat with the model and persisted global permission preference', async () => {
    useSessionStore.setState({
      model: 'k3',
      thinkingLevel: 'high',
      permissionPreference: 'auto',
      permission: 'manual',
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
