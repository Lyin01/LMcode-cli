import { useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { useTaskStore } from '@/stores/task-store'
import { useInboxStore } from '@/stores/inbox-store'
import { startInboxFeed } from '@/lib/inbox-feed'

/**
 * 挂载 inbox 事件接线：后台会话回合完成、审批请求、子代理/后台任务
 * 终态、目标状态变更都会投影成收件箱条目。在 App 根部挂载一次。
 */
export function useInbox(): void {
  useEffect(
    () =>
      startInboxFeed({
        sessionStore: useSessionStore,
        subagentStore: useSubagentStore,
        taskStore: useTaskStore,
        inboxStore: useInboxStore,
        notifyTurnCompleted: (payload) => {
          window.lmcodeAPI.sendDesktopNotification(payload)
        },
        subscribeSessionEvents: (callback) => window.lmcodeAPI.onSessionEvent(callback),
      }),
    [],
  )
}
