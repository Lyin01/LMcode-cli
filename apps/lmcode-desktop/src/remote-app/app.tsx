import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ApprovalRequest, ApprovalResponse, QuestionRequest, QuestionResult, SessionSummary } from '@lmcode-cli/lmcode-sdk'
import type { RemoteServerMessage } from '../shared/remote-types'
import { RemoteClient, remoteSocketUrl, type ConnectionPhase } from './client'
import { forgetToken, resolveInitialToken, saveToken } from './pairing'
import {
  appendUserItem,
  createTranscript,
  historyToTranscript,
  reduceTranscript,
  type TranscriptState,
} from './transcript'
import { ChatView } from './views/chat'
import { PairingView } from './views/pairing'
import { SessionsView, type CreateSessionParams } from './views/sessions'
import { ApprovalSheet, QuestionSheet } from './views/sheets'

interface PendingApproval {
  readonly requestId: string
  readonly request: ApprovalRequest
}

interface PendingQuestion {
  readonly requestId: string
  readonly request: QuestionRequest
}

export function App() {
  const [token, setToken] = useState<string | null>(() => resolveInitialToken())
  const [connectionNonce, setConnectionNonce] = useState(0)
  const [phase, setPhase] = useState<ConnectionPhase>('connecting')
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [projects, setProjects] = useState<readonly string[]>([])
  const [noProjectWorkDir, setNoProjectWorkDir] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeTitle, setActiveTitle] = useState('')
  const [transcript, setTranscript] = useState<TranscriptState>(() => createTranscript())
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)

  const clientRef = useRef<RemoteClient | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    runningRef.current = transcript.running
  }, [transcript.running])

  const loadTranscript = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (client === null) return
    setTranscriptLoading(true)
    try {
      const history = await client.request('sessions.history', { id: sessionId })
      if (activeIdRef.current !== sessionId) return
      setTranscript(historyToTranscript(Array.isArray(history) ? history : []))
    } catch (loadError) {
      if (activeIdRef.current === sessionId) setError(errorText(loadError))
    } finally {
      setTranscriptLoading(false)
    }
  }, [])

  const refreshSessionList = useCallback(async () => {
    const client = clientRef.current
    if (client === null) return
    try {
      const list = await client.request('sessions.list', {})
      setSessions([...list])
    } catch (refreshError) {
      setError(errorText(refreshError))
    }
  }, [])

  /** Re-pull everything that may have moved while the socket was down. */
  const resync = useCallback(async () => {
    const client = clientRef.current
    if (client === null) return
    try {
      const [list, system, projectList] = await Promise.all([
        client.request('sessions.list', {}),
        client.request('system.info', {}),
        client.request('sessions.projects', {}),
      ])
      setSessions([...list])
      setProjects([...projectList])
      setNoProjectWorkDir(system.noProjectWorkDir ?? null)
      setError(null)
      const active = activeIdRef.current
      if (active !== null) await loadTranscript(active)
    } catch (syncError) {
      setError(errorText(syncError))
    }
  }, [loadTranscript])

  const handleServerMessage = useCallback(
    (message: RemoteServerMessage) => {
      switch (message.type) {
        case 'auth-ok':
          void resync()
          return
        case 'event': {
          const event = message.event
          if (event.type === 'session.meta.updated' && typeof event.title === 'string') {
            const nextTitle = event.title
            setSessions((previous) =>
              previous.map((session) =>
                session.id === message.sessionId ? { ...session, title: nextTitle } : session,
              ),
            )
          }
          if (message.sessionId === activeIdRef.current) {
            setTranscript((previous) => reduceTranscript(previous, event))
          }
          return
        }
        case 'approval':
          setPendingApproval({ requestId: message.requestId, request: message.request })
          return
        case 'question':
          setPendingQuestion({ requestId: message.requestId, request: message.request })
          return
        case 'settled':
          setPendingApproval((previous) =>
            previous?.requestId === message.requestId ? null : previous,
          )
          setPendingQuestion((previous) =>
            previous?.requestId === message.requestId ? null : previous,
          )
          return
        default:
          return
      }
    },
    [resync],
  )

  useEffect(() => {
    if (token === null) return
    const client = new RemoteClient(remoteSocketUrl(window.location), token)
    clientRef.current = client
    const unsubscribe = client.subscribe({
      onPhase: (next) => setPhase(next),
      onMessage: (message) => handleServerMessage(message),
    })
    client.connect()
    return () => {
      unsubscribe()
      client.close()
      if (clientRef.current === client) clientRef.current = null
    }
  }, [token, connectionNonce, handleServerMessage])

  const openSession = useCallback(
    async (id: string) => {
      const client = clientRef.current
      if (client === null) return
      setBusy(true)
      setError(null)
      try {
        const resumed = await client.request('sessions.resume', { id })
        activeIdRef.current = id
        setActiveId(id)
        setActiveTitle(
          resumed.summary.title?.trim() || resumed.summary.lastPrompt?.trim() || '会话',
        )
        setTranscript(createTranscript())
        await loadTranscript(id)
      } catch (openError) {
        setError(errorText(openError))
      } finally {
        setBusy(false)
      }
    },
    [loadTranscript],
  )

  const createSession = useCallback(
    async (params: CreateSessionParams) => {
      const client = clientRef.current
      if (client === null) return
      setBusy(true)
      setError(null)
      try {
        const summary = await client.request('sessions.create', params)
        await openSession(summary.id)
      } catch (createError) {
        setError(errorText(createError))
      } finally {
        setBusy(false)
      }
    },
    [openSession],
  )

  const leaveSession = useCallback(() => {
    activeIdRef.current = null
    setActiveId(null)
    setActiveTitle('')
    setTranscript(createTranscript())
    void refreshSessionList()
  }, [refreshSessionList])

  const sendMessage = useCallback(
    async (text: string) => {
      const client = clientRef.current
      const sessionId = activeIdRef.current
      const trimmed = text.trim()
      if (client === null || sessionId === null || trimmed.length === 0) return
      setError(null)
      setTranscript((previous) => appendUserItem(previous, trimmed))
      try {
        if (runningRef.current) {
          await client.request('chat.steer', { sessionId, text: trimmed })
        } else {
          await client.request('chat.send', { sessionId, text: trimmed })
        }
        void refreshSessionList()
      } catch (sendError) {
        setError(errorText(sendError))
      }
    },
    [refreshSessionList],
  )

  const cancelRun = useCallback(async () => {
    const client = clientRef.current
    const sessionId = activeIdRef.current
    if (client === null || sessionId === null) return
    setError(null)
    try {
      await client.request('chat.cancel', { sessionId })
    } catch (cancelError) {
      setError(errorText(cancelError))
    }
  }, [])

  const respondApproval = useCallback((requestId: string, response: ApprovalResponse) => {
    clientRef.current?.respondApproval(requestId, response)
    setPendingApproval((previous) => (previous?.requestId === requestId ? null : previous))
  }, [])

  const respondQuestion = useCallback((requestId: string, result: QuestionResult) => {
    clientRef.current?.respondQuestion(requestId, result)
    setPendingQuestion((previous) => (previous?.requestId === requestId ? null : previous))
  }, [])

  const submitToken = useCallback((next: string) => {
    const trimmed = next.trim()
    if (trimmed.length === 0) return
    saveToken(trimmed)
    setError(null)
    setPhase('connecting')
    setToken(trimmed)
    setConnectionNonce((value) => value + 1)
  }, [])

  const forgetDevice = useCallback(() => {
    forgetToken()
    activeIdRef.current = null
    setToken(null)
    setPhase('connecting')
    setSessions([])
    setProjects([])
    setActiveId(null)
    setActiveTitle('')
    setTranscript(createTranscript())
  }, [])

  const pairingRequired = token === null || phase === 'unauthorized'
  const showSplash =
    !pairingRequired && activeId === null && sessions.length === 0 && phase !== 'online'
  const showConnectionBanner = !pairingRequired && !showSplash && phase !== 'online'

  let body: ReactNode
  if (pairingRequired) {
    body = (
      <PairingView
        error={
          phase === 'unauthorized'
            ? '配对令牌已失效，请重新扫码，或在电脑上复制新的令牌。'
            : error
        }
        busy={false}
        canForget={token !== null}
        onSubmit={submitToken}
        onForget={forgetDevice}
      />
    )
  } else if (showSplash) {
    body = (
      <div className="rm-splash">
        <div className="rm-logo">LMCODE</div>
        <p className="rm-muted">{phase === 'offline' ? '连接断开，正在重连…' : '正在连接电脑…'}</p>
      </div>
    )
  } else if (activeId === null) {
    body = (
      <SessionsView
        sessions={sessions}
        projects={projects}
        noProjectWorkDir={noProjectWorkDir}
        busy={busy}
        onOpen={(id) => void openSession(id)}
        onRefresh={() => void refreshSessionList()}
        onCreate={(params) => void createSession(params)}
      />
    )
  } else {
    body = (
      <ChatView
        title={activeTitle}
        phase={phase}
        running={transcript.running}
        loading={transcriptLoading}
        items={transcript.items}
        onBack={leaveSession}
        onSend={(text) => void sendMessage(text)}
        onCancel={() => void cancelRun()}
      />
    )
  }

  return (
    <div className="rm-app">
      {showConnectionBanner && (
        <div className="rm-banner">
          {phase === 'connecting' ? '正在连接电脑…' : '连接断开，正在重连…'}
        </div>
      )}
      {error !== null && !pairingRequired && (
        <div className="rm-banner rm-banner-error">
          <span>{error}</span>
          <button className="rm-ghost" type="button" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}
      {body}
      {pendingApproval !== null && (
        <ApprovalSheet
          request={pendingApproval.request}
          onRespond={(response) => respondApproval(pendingApproval.requestId, response)}
        />
      )}
      {pendingQuestion !== null && (
        <QuestionSheet
          request={pendingQuestion.request}
          onSubmit={(result) => respondQuestion(pendingQuestion.requestId, result)}
        />
      )}
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
