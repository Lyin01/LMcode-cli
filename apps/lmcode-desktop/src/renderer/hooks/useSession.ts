import { useCallback } from 'react'
import { useSessionStore } from '@/stores/session-store'

export function useSession() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const setStreaming = useSessionStore((s) => s.setStreaming)
  const addMessage = useSessionStore((s) => s.addMessage)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSessionAction = useSessionStore((s) => s.createSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)

  const sendMessage = useCallback(
    async (text: string) => {
      if (!currentSessionId || !text.trim() || isStreaming) return

      // Add user message
      addMessage({
        id: `msg_${Date.now()}`,
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
      })

      setStreaming(true)

      try {
        await window.lmcodeAPI.sendMessage(currentSessionId, text.trim())
      } catch (err) {
        // The turn threw before/while producing a reply. Don't fail silently —
        // the user must see *something* instead of an empty, stuck-looking chat.
        console.error('Failed to send message:', err)
        const msg = err instanceof Error ? err.message : String(err)
        addMessage({
          id: `msg_err_${Date.now()}`,
          role: 'system',
          variant: 'error',
          content: `发送失败：${msg}`,
          timestamp: Date.now(),
        })
        setStreaming(false)
        useSessionStore.getState().setStreamStatus(null)
      }
    },
    [currentSessionId, isStreaming, addMessage, setStreaming],
  )

  const cancel = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.lmcodeAPI.cancelResponse(currentSessionId)
    } catch (err) {
      console.error('Failed to cancel:', err)
    }
    setStreaming(false)
  }, [currentSessionId, setStreaming])

  const createSession = useCallback(async () => {
    await createSessionAction()
  }, [createSessionAction])

  return {
    currentSessionId,
    isStreaming,
    sendMessage,
    cancel,
    selectSession,
    createSession,
    clearMessages,
  }
}
