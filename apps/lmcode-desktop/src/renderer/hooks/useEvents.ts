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
  const enqueuePendingInteraction = useSessionStore((s) => s.enqueuePendingInteraction)
  const discardPendingInteraction = useSessionStore((s) => s.discardPendingInteraction)
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
      enqueuePendingInteraction({ kind: 'approval', payload: request })
    })

    const unsubQuestion = window.lmcodeAPI.onQuestionRequest((request: QuestionRequestPayload) => {
      enqueuePendingInteraction({ kind: 'question', payload: request })
    })

    const unsubInteractionSettled = window.lmcodeAPI.onInteractionSettled(({ requestId }) => {
      discardPendingInteraction(requestId)
    })

    return () => {
      unsubEvent()
      unsubApproval()
      unsubQuestion()
      unsubInteractionSettled()
    }
  }, [handleEvent, enqueuePendingInteraction, discardPendingInteraction, addOrUpdateTask])
}
