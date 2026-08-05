import { beforeEach, describe, expect, it } from 'vitest'
import type { Event } from '@lmcode-cli/lmcode-sdk'
import { startArtifactFeed } from '@/lib/artifact-feed'
import { useArtifactsStore } from '@/stores/artifacts-store'
import { useInboxStore } from '@/stores/inbox-store'
import { useSessionStore } from '@/stores/session-store'

type SessionEventCallback = (payload: { sessionId: string; event: Event }) => void

function emit(callback: SessionEventCallback, sessionId: string, event: Event): void {
  callback({ sessionId, event })
}

/** 与线上事件同形：SDK 事件携带 agentId/sessionId 信封字段。 */
function planEvent(toolCallId: string, plan: string, path?: string): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId,
    name: 'ExitPlanMode',
    args: {},
    display: { kind: 'plan_review', plan, path },
    agentId: 'main',
    sessionId: 's1',
  } as Event
}

function writeStarted(toolCallId: string, path: string, content: string): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId,
    name: 'Write',
    args: { path, content },
    agentId: 'main',
    sessionId: 's1',
  } as Event
}

function writeResult(toolCallId: string, isError?: boolean): Event {
  return {
    type: 'tool.result',
    turnId: 1,
    toolCallId,
    output: { bytesWritten: 10 },
    isError,
    agentId: 'main',
    sessionId: 's1',
  } as Event
}

describe('artifact feed', () => {
  let callback: SessionEventCallback
  let dispose: () => void

  beforeEach(() => {
    useArtifactsStore.setState({ artifacts: [], panelArtifactId: null })
    useInboxStore.setState({ items: [] })
    useSessionStore.setState({ sessions: [] })
    dispose = startArtifactFeed({
      artifactsStore: useArtifactsStore,
      inboxStore: useInboxStore,
      sessionStore: useSessionStore,
      subscribeSessionEvents: (cb) => {
        callback = cb
        return () => {}
      },
    })
  })

  it('commits a plan artifact at ExitPlanMode start and notifies the inbox', () => {
    emit(callback, 's1', planEvent('tc-plan', '# 计划', '/tmp/plan.md'))

    const artifacts = useArtifactsStore.getState().artifacts
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('plan')
    const items = useInboxStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('artifact-updated')
    expect(items[0]?.title).toBe('新文档待审阅：plan.md')
    expect(items[0]?.id).toBe(`artifact:${artifacts[0]?.id}`)
    dispose()
  })

  it('titles the inbox entry as an update when the same artifact is revised', () => {
    emit(callback, 's1', planEvent('tc-plan-1', '# 计划 v1'))
    emit(callback, 's1', planEvent('tc-plan-2', '# 计划 v2'))

    expect(useArtifactsStore.getState().artifacts[0]?.version).toBe(2)
    expect(useInboxStore.getState().items[0]?.title).toBe('文档已更新：实施计划')
    dispose()
  })

  it('defers report artifacts until the Write succeeds, dropping failed writes', () => {
    emit(callback, 's1', writeStarted('tc-write', 'docs/report.md', '# 报告'))
    // started 阶段不落库：审批可能被拒、写入可能失败。
    expect(useArtifactsStore.getState().artifacts).toHaveLength(0)

    emit(callback, 's1', writeResult('tc-write', true))
    expect(useArtifactsStore.getState().artifacts).toHaveLength(0)
    expect(useInboxStore.getState().items).toHaveLength(0)

    emit(callback, 's1', writeStarted('tc-write', 'docs/report.md', '# 报告'))
    emit(callback, 's1', writeResult('tc-write'))
    const artifacts = useArtifactsStore.getState().artifacts
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('report')
    expect(artifacts[0]?.toolCallIds).toEqual(['tc-write'])
    dispose()
  })
})
