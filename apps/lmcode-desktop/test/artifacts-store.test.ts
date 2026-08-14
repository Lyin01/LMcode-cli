import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeCommentCount,
  artifactIdForToolCall,
  useArtifactsStore,
} from '@/stores/artifacts-store'

describe('artifacts store', () => {
  beforeEach(() => {
    useArtifactsStore.setState({ artifacts: [], panelArtifactId: null })
  })

  it('creates an artifact with version 1 and derives a stable id from kind/session/key', () => {
    const artifact = useArtifactsStore.getState().upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划',
      content: '# 计划\n\n第一步',
      toolCallId: 'tc-1',
    })

    expect(artifact.id).toBe('plan:s1:plan')
    expect(artifact.version).toBe(1)
    expect(artifact.comments).toEqual([])
    expect(artifactIdForToolCall(useArtifactsStore.getState().artifacts, 'tc-1')).toBe(artifact.id)
  })

  it('bumps the version and refreshes content when the same artifact is updated', () => {
    const store = useArtifactsStore.getState()
    store.upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划',
      content: '旧内容',
      toolCallId: 'tc-1',
    })
    const updated = useArtifactsStore.getState().upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划 v2',
      content: '新内容',
      toolCallId: 'tc-2',
    })

    expect(useArtifactsStore.getState().artifacts).toHaveLength(1)
    expect(updated.version).toBe(2)
    expect(updated.content).toBe('新内容')
    expect(updated.title).toBe('实施计划 v2')
    expect(updated.toolCallIds).toEqual(['tc-1', 'tc-2'])
  })

  it('appends content instead of replacing when the update is an append write', () => {
    const store = useArtifactsStore.getState()
    store.upsert({
      sessionId: 's1',
      kind: 'report',
      key: 'docs/a.md',
      title: 'a.md',
      content: '# 报告\n',
    })
    const updated = useArtifactsStore.getState().upsert({
      sessionId: 's1',
      kind: 'report',
      key: 'docs/a.md',
      title: 'a.md',
      content: '补充段落',
      append: true,
    })

    expect(updated.content).toBe('# 报告\n补充段落')
    expect(updated.version).toBe(2)
  })

  it('adds and removes comments anchored to blocks', () => {
    const store = useArtifactsStore.getState()
    const artifact = store.upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划',
      content: '第一段\n\n第二段',
    })
    useArtifactsStore.getState().addComment(
      artifact.id,
      { blockIndex: 1, excerpt: '第二段' },
      '这里要补充回滚方案',
    )

    let current = useArtifactsStore.getState().artifacts[0]
    expect(current?.comments).toHaveLength(1)
    expect(current?.comments[0]?.outdated).toBe(false)
    expect(activeCommentCount(current!)).toBe(1)

    useArtifactsStore.getState().removeComment(artifact.id, current!.comments[0]!.id)
    current = useArtifactsStore.getState().artifacts[0]
    expect(current?.comments).toHaveLength(0)
  })

  it('marks a comment outdated immediately when its anchor block does not exist', () => {
    const store = useArtifactsStore.getState()
    const artifact = store.upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划',
      content: '唯一段落',
    })
    useArtifactsStore.getState().addComment(
      artifact.id,
      { blockIndex: 5, excerpt: '不存在' },
      '越界评论',
    )

    const current = useArtifactsStore.getState().artifacts[0]
    expect(current?.comments[0]?.outdated).toBe(true)
  })

  it('re-anchors comments on update: matching excerpts survive, mismatches go outdated without deletion', () => {
    const store = useArtifactsStore.getState()
    const artifact = store.upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划',
      content: '第一段保持\n\n第二段会被改',
    })
    useArtifactsStore.getState().addComment(
      artifact.id,
      { blockIndex: 0, excerpt: '第一段保持' },
      '保留意见',
    )
    useArtifactsStore.getState().addComment(
      artifact.id,
      { blockIndex: 1, excerpt: '第二段会被改' },
      '失效意见',
    )

    const updated = useArtifactsStore.getState().upsert({
      sessionId: 's1',
      kind: 'plan',
      key: 'plan',
      title: '实施计划',
      content: '第一段保持\n\n第二段已重写',
    })

    expect(updated.version).toBe(2)
    expect(updated.comments).toHaveLength(2)
    expect(updated.comments[0]?.outdated).toBe(false)
    expect(updated.comments[1]?.outdated).toBe(true)
    expect(activeCommentCount(updated)).toBe(1)
  })

  it('opens and closes the review panel', () => {
    useArtifactsStore.getState().openPanel('plan:s1:plan')
    expect(useArtifactsStore.getState().panelArtifactId).toBe('plan:s1:plan')
    useArtifactsStore.getState().closePanel()
    expect(useArtifactsStore.getState().panelArtifactId).toBeNull()
  })
})
