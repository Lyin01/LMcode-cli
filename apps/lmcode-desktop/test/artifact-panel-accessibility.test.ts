import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPanel } from '@/components/ArtifactPanel'
import * as artifactsStoreModule from '@/stores/artifacts-store'
import type { Artifact, ArtifactsStore } from '@/stores/artifacts-store'

let artifactsState: ArtifactsStore

function fixtureArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'plan:s1:plan',
    sessionId: 's1',
    kind: 'plan',
    title: 'plan.md',
    content: '# 实施计划\n\n第一步：改代码\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 2,
    comments: [
      {
        id: 'c-1',
        anchor: { blockIndex: 1, excerpt: '第一步：改代码' },
        text: '这里要补充回滚方案',
        createdAt: Date.now(),
        outdated: false,
      },
    ],
    toolCallIds: ['tc-1'],
    ...overrides,
  }
}

describe('artifact review drawer accessibility contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    artifactsState = {
      ...artifactsStoreModule.useArtifactsStore.getState(),
      artifacts: [fixtureArtifact()],
      panelArtifactId: 'plan:s1:plan',
    }
    // renderToStaticMarkup resolves zustand's server snapshot, so the drawer
    // contract tests drive a fixture state through the hook instead — same
    // pattern as the inbox tests.
    vi.spyOn(artifactsStoreModule, 'useArtifactsStore').mockImplementation(
      ((selector) => selector(artifactsState)) as typeof artifactsStoreModule.useArtifactsStore,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is a named modal dialog with labelled controls and version metadata', () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactPanel, { onSendFeedback: vi.fn() }),
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="lm-artifact-panel-title"')
    expect(html).toContain('id="lm-artifact-panel-title"')
    expect(html).toContain('aria-label="关闭文档审阅"')
    expect(html).toContain('title="关闭文档审阅"')
    expect(html).toContain('data-lm-autofocus="true"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('aria-label="发送反馈"')
    expect(html).toContain('plan.md')
    expect(html).toContain('v2')
  })

  it('renders top-level blocks with per-paragraph comment affordances', () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactPanel, { onSendFeedback: vi.fn() }),
    )

    // 三个顶层块：标题 / 段落 / 围栏代码块（内部空行不构成边界）。
    expect(html.match(/data-lm-artifact-block=/g)).toHaveLength(3)
    expect(html).toContain('aria-label="评论第 1 段"')
    expect(html).toContain('aria-label="评论第 2 段"')
    expect(html).toContain('aria-label="评论第 3 段"')
    // 已有评论：侧栏列出原文与定位摘录，可删除。
    expect(html).toContain('这里要补充回滚方案')
    expect(html).toContain('第一步：改代码')
    expect(html).toContain('aria-label="删除评论"')
    expect(html).toContain('发送反馈（1）')
  })

  it('marks outdated comments and excludes them from the feedback count', () => {
    artifactsState = {
      ...artifactsState,
      artifacts: [
        fixtureArtifact({
          comments: [
            {
              id: 'c-1',
              anchor: { blockIndex: 1, excerpt: '旧摘录' },
              text: '失效意见',
              createdAt: Date.now(),
              outdated: true,
            },
          ],
        }),
      ],
    }

    const html = renderToStaticMarkup(
      createElement(ArtifactPanel, { onSendFeedback: vi.fn() }),
    )

    expect(html).toContain('已过期')
    expect(html).toContain('发送反馈（0）')
  })

  it('renders nothing while closed', () => {
    artifactsState = { ...artifactsState, panelArtifactId: null }
    expect(
      renderToStaticMarkup(createElement(ArtifactPanel, { onSendFeedback: vi.fn() })),
    ).toBe('')
  })
})
