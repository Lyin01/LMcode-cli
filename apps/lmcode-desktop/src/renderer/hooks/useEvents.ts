import { useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { createSessionEventBatcher } from '@/lib/session-event-batcher'
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
  const subagentSpawned = useSubagentStore((s) => s.spawned)
  const subagentCompleted = useSubagentStore((s) => s.completed)
  const subagentFailed = useSubagentStore((s) => s.failed)

  useEffect(() => {
    // Deltas arrive one IPC at a time; the batcher coalesces adjacent text
    // deltas into ordered segments so the store publishes once per batching
    // window instead of once per delta. Non-delta events flush synchronously
    // first, so store-visible order matches arrival order.
    const batcher = createSessionEventBatcher(handleEvent)
    const unsubEvent = window.lmcodeAPI.onSessionEvent((payload: SessionEventPayload) => {
      const { sessionId, event } = payload

      // Forward the actual Event (not the {sessionId, event} envelope) to the
      // session store for chat/message rendering.
      batcher.push(sessionId, event)

      // Handle background task events
      if (event?.type === 'background.task.started' && event?.info) {
        addOrUpdateTask(sessionId, event.info)
      } else if (event?.type === 'background.task.updated' && event?.info) {
        addOrUpdateTask(sessionId, event.info)
      } else if (event?.type === 'background.task.terminated' && event?.info) {
        addOrUpdateTask(sessionId, event.info)
      } else if (event?.type === 'subagent.spawned') {
        subagentSpawned(sessionId, event)
      } else if (event?.type === 'subagent.completed') {
        subagentCompleted(sessionId, event)
      } else if (event?.type === 'subagent.failed') {
        subagentFailed(sessionId, event)
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
      // Flush any pending segment before the listener goes away.
      batcher.dispose()
      unsubApproval()
      unsubQuestion()
      unsubInteractionSettled()
    }
  }, [
    handleEvent,
    enqueuePendingInteraction,
    discardPendingInteraction,
    addOrUpdateTask,
    subagentSpawned,
    subagentCompleted,
    subagentFailed,
  ])
}
