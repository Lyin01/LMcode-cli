import { useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import type {
  ApprovalRequestPayload,
  QuestionRequestPayload,
  SessionEventPayload,
} from '@/types'

export function useEvents() {
  const handleEvent = useSessionStore((s) => s.handleEvent)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setPendingApproval = useSessionStore((s) => s.setPendingApproval)
  const setPendingQuestion = useSessionStore((s) => s.setPendingQuestion)
  const addOrUpdateTask = useTaskStore((s) => s.addOrUpdateTask)

  useEffect(() => {
    const unsubEvent = window.lmcodeAPI.onSessionEvent((payload: SessionEventPayload) => {
      const { sessionId, event } = payload

      // Forward the actual Event (not the {sessionId, event} envelope) to the
      // session store for chat/message rendering.
      handleEvent(sessionId, event)

      // Handle background task events
      if (event?.type === 'background.task.started' && event?.info) {
        addOrUpdateTask(sessionId, event.info)
      } else if (event?.type === 'background.task.updated' && event?.info) {
        addOrUpdateTask(sessionId, event.info)
      } else if (event?.type === 'background.task.terminated' && event?.info) {
        addOrUpdateTask(sessionId, event.info)
      }
    })

    const unsubApproval = window.lmcodeAPI.onApprovalRequest((request: ApprovalRequestPayload) => {
      setPendingApproval(request)
    })

    const unsubQuestion = window.lmcodeAPI.onQuestionRequest((request: QuestionRequestPayload) => {
      setPendingQuestion(request)
    })

    return () => {
      unsubEvent()
      unsubApproval()
      unsubQuestion()
    }
  }, [handleEvent, setPendingApproval, setPendingQuestion, addOrUpdateTask])
}
