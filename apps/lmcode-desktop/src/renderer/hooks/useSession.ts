import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { createDesktopPromptRequest } from '@/lib/prompt-request'
import type { QueuedUserMessage, UserAttachment } from '@/types'

const EMPTY_QUEUE: readonly QueuedUserMessage[] = []
const EMPTY_ATTACHMENTS: readonly UserAttachment[] = []

function toDisplayAttachment(attachment: UserAttachment): UserAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    truncated: attachment.truncated,
    previewUrl: attachment.previewUrl,
  }
}

export function useSession() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const setSessionStreaming = useSessionStore((s) => s.setSessionStreaming)
  const addMessageToSession = useSessionStore((s) => s.addMessageToSession)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSessionAction = useSessionStore((s) => s.createSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const queuedMessages = useSessionStore((s) =>
    currentSessionId ? s.messageQueue[currentSessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE,
  )
  const enqueueMessage = useSessionStore((s) => s.enqueueMessage)
  const shiftQueuedMessage = useSessionStore((s) => s.shiftQueuedMessage)
  const drainInFlight = useRef(false)
  const [, setDrainTick] = useState(0)

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
    try {
      await window.lmcodeAPI.cancelResponse(currentSessionId)
    } catch (err) {
      console.error('Failed to cancel:', err)
    }
    setSessionStreaming(currentSessionId, false)
  }, [currentSessionId, setSessionStreaming])

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
    enqueueMessage(currentSessionId, normalized, attachments)
  }, [currentSessionId, enqueueMessage])

  useEffect(() => {
    if (
      !currentSessionId ||
      isStreaming ||
      queuedMessages.length === 0 ||
      drainInFlight.current
    ) return

    let next = shiftQueuedMessage(currentSessionId)
    while (next && !next.text.trim() && next.attachments.length === 0) {
      next = shiftQueuedMessage(currentSessionId)
    }
    if (!next) return

    drainInFlight.current = true
    void sendMessage(next.text, next.attachments).finally(() => {
      drainInFlight.current = false
      setDrainTick((value) => value + 1)
    })
  }, [currentSessionId, isStreaming, queuedMessages, sendMessage, shiftQueuedMessage])

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
