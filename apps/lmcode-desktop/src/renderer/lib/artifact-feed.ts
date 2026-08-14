import type { Event } from '@lmcode-cli/lmcode-sdk'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { ArtifactsStore } from '@/stores/artifacts-store'
import type { InboxStore } from '@/stores/inbox-store'
import type { SessionStore } from '@/stores/session-store'
import { detectArtifactStart, type ArtifactDetection } from '@/lib/artifact-detect'

/**
 * Artifact 事件接线：把会话事件流里的 artifact 检测投影成 artifacts-store
 * 条目，并向 inbox 发 `artifact-updated` 通知。与 React 解耦，便于直接
 * 驱动 store 做契约测试；`useArtifacts` 只是把这层接线挂到真实 store
 * 和 IPC 桥上（与 inbox-feed 同一模式）。
 */

type ArtifactsStoreApi = UseBoundStore<StoreApi<ArtifactsStore>>
type InboxStoreApi = UseBoundStore<StoreApi<InboxStore>>
type SessionStoreApi = UseBoundStore<StoreApi<SessionStore>>

export interface ArtifactFeedDeps {
  readonly artifactsStore: ArtifactsStoreApi
  readonly inboxStore: InboxStoreApi
  readonly sessionStore: SessionStoreApi
  readonly subscribeSessionEvents: (
    callback: (payload: { sessionId: string; event: Event }) => void,
  ) => () => void
}

function commitArtifact(
  deps: ArtifactFeedDeps,
  sessionId: string,
  detection: ArtifactDetection,
): void {
  const artifact = deps.artifactsStore.getState().upsert({
    sessionId,
    kind: detection.kind,
    key: detection.key,
    title: detection.title,
    content: detection.content,
    toolCallId: detection.toolCallId,
    append: detection.append,
  })
  const sessionState = deps.sessionStore.getState()
  const workDir = sessionState.sessions.find((session) => session.id === sessionId)?.workDir
  deps.inboxStore.getState().add({
    // id 前缀编码 artifactId，InboxPanel 点击时据此打开审阅面板。
    id: `artifact:${artifact.id}`,
    type: 'artifact-updated',
    sessionId,
    projectDir: workDir || undefined,
    title:
      artifact.version > 1 ? `文档已更新：${artifact.title}` : `新文档待审阅：${artifact.title}`,
    outcome: 'info',
    mergeKey: `artifact-updated:${artifact.id}`,
  })
}

/**
 * 启动接线，返回销毁函数。plan 在 ExitPlanMode 呈现时（started）立即落库；
 * report 先按 toolCallId 暂存，等 Write 成功（tool.result 非错误）才落库，
 * 避免审批拒绝/写失败产生幽灵文档。
 */
export function startArtifactFeed(deps: ArtifactFeedDeps): () => void {
  const pendingReports = new Map<string, ArtifactDetection>()

  return deps.subscribeSessionEvents(({ sessionId, event }) => {
    if (event.type === 'tool.call.started') {
      const detection = detectArtifactStart(event)
      if (!detection) return
      if (detection.kind === 'plan') {
        commitArtifact(deps, sessionId, detection)
      } else {
        pendingReports.set(detection.toolCallId, detection)
      }
      return
    }
    if (event.type === 'tool.result') {
      const detection = pendingReports.get(event.toolCallId)
      if (detection === undefined) return
      pendingReports.delete(event.toolCallId)
      if (event.isError === true) return
      commitArtifact(deps, sessionId, detection)
    }
  })
}
