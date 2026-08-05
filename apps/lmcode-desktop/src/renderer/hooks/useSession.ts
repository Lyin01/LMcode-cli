import { useCallback } from 'react'
import { toDisplayAttachment, useSessionStore } from '@/stores/session-store'
import { cancelResponseSafely } from '@/lib/cancel-response'
import { createDesktopPromptRequest } from '@/lib/prompt-request'
import type { UserAttachment } from '@/types'

const EMPTY_ATTACHMENTS: readonly UserAttachment[] = []

export function useSession() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const setSessionStreaming = useSessionStore((s) => s.setSessionStreaming)
  const addMessageToSession = useSessionStore((s) => s.addMessageToSession)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSessionAction = useSessionStore((s) => s.createSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const enqueueMessage = useSessionStore((s) => s.enqueueMessage)

  const sendMessage = useCallback(
    async (text: string, attachments: readonly UserAttachment[] = EMPTY_ATTACHMENTS) => {
      const normalized = text.trim()
      if (!currentSessionId || (!normalized && attachments.length === 0) || isStreaming) return

      // Add user message
      addMessageToSession(currentSessionId, {
        id: `msg_${Date.now()}`,
        role: 'user',
        content: normalized,
        attachments: attachments.map(toDisplayAttachment),
        timestamp: Date.now(),
      })

      setSessionStreaming(currentSessionId, true)

      try {
        await window.lmcodeAPI.sendMessage(
          currentSessionId,
          createDesktopPromptRequest(normalized, attachments),
        )
      } catch (err) {
        // The turn threw before/while producing a reply. Don't fail silently —
        // the user must see *something* instead of an empty, stuck-looking chat.
        console.error('Failed to send message:', err)
        const msg = err instanceof Error ? err.message : String(err)
        addMessageToSession(currentSessionId, {
          id: `msg_err_${Date.now()}`,
          role: 'system',
          variant: 'error',
          content: `发送失败：${msg}`,
          timestamp: Date.now(),
        })
        setSessionStreaming(currentSessionId, false)
      }
    },
    [currentSessionId, isStreaming, addMessageToSession, setSessionStreaming],
  )

  const cancel = useCallback(async () => {
    if (!currentSessionId) return
    // Streaming state is owned by the turn.ended event: a successful cancel
    // waits for it, and a failed one leaves the still-running session marked
    // as streaming. Only the failure is surfaced here — as a visible error
    // message, after which the stop button can be retried.
    await cancelResponseSafely(currentSessionId, {
      cancelResponse: (sessionId) => window.lmcodeAPI.cancelResponse(sessionId),
      onError: (message) =>
        addMessageToSession(currentSessionId, {
          id: `msg_cancel_err_${Date.now()}`,
          role: 'system',
          variant: 'error',
          content: `停止失败：${message}`,
          timestamp: Date.now(),
        }),
      logError: (err) => console.error('Failed to cancel:', err),
    })
  }, [currentSessionId, addMessageToSession])

  const steerMessage = useCallback(async (
    text: string,
    attachments: readonly UserAttachment[] = EMPTY_ATTACHMENTS,
  ) => {
    const normalized = text.trim()
    if (!currentSessionId || !isStreaming || (!normalized && attachments.length === 0)) return
    addMessageToSession(currentSessionId, {
      id: `msg_steer_${Date.now()}`,
      role: 'user',
      content: normalized,
      attachments: attachments.map(toDisplayAttachment),
      timestamp: Date.now(),
    })
    try {
      await window.lmcodeAPI.steerMessage(
        currentSessionId,
        createDesktopPromptRequest(normalized, attachments),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      addMessageToSession(currentSessionId, {
        id: `msg_steer_err_${Date.now()}`,
        role: 'system',
        variant: 'error',
        content: `转向失败：${message}`,
        timestamp: Date.now(),
      })
    }
  }, [addMessageToSession, currentSessionId, isStreaming])

  const queueMessage = useCallback((
    text: string,
    attachments: readonly UserAttachment[] = EMPTY_ATTACHMENTS,
  ) => {
    const normalized = text.trim()
    if (!currentSessionId || (!normalized && attachments.length === 0)) return
    // Enqueueing wakes the store-level queue drain, which owns sending —
    // mounted exactly once, so duplicate hook instances can't double-send.
    enqueueMessage(currentSessionId, normalized, attachments)
  }, [currentSessionId, enqueueMessage])

  const createSession = useCallback(async (workDir?: string) => {
    await createSessionAction(workDir)
  }, [createSessionAction])

  return {
    currentSessionId,
    isStreaming,
    sendMessage,
    steerMessage,
    queueMessage,
    cancel,
    selectSession,
    createSession,
    clearMessages,
  }
}
