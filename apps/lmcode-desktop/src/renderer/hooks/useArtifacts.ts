import { useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useInboxStore } from '@/stores/inbox-store'
import { useArtifactsStore } from '@/stores/artifacts-store'
import { startArtifactFeed } from '@/lib/artifact-feed'

/**
 * 挂载 artifact 事件接线：plan 呈现、markdown 报告写出会投影成
 * artifacts-store 条目并通知 inbox。在 App 根部挂载一次。
 */
export function useArtifacts(): void {
  useEffect(
    () =>
      startArtifactFeed({
        artifactsStore: useArtifactsStore,
        inboxStore: useInboxStore,
        sessionStore: useSessionStore,
        subscribeSessionEvents: (callback) => window.lmcodeAPI.onSessionEvent(callback),
      }),
    [],
  )
}
