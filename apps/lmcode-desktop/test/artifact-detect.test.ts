import { describe, expect, it } from 'vitest'
import type { Event, ToolCallStartedEvent } from '@lmcode-cli/lmcode-sdk'
import { detectArtifactStart } from '@/lib/artifact-detect'

function toolCallStarted(partial: Partial<ToolCallStartedEvent>): Event {
  return {
    type: 'tool.call.started',
    turnId: 1,
    toolCallId: 'tc-1',
    name: 'Write',
    args: {},
    agentId: 'main',
    sessionId: 's1',
    ...partial,
  } as Event
}

describe('artifact detection from session events', () => {
  it('detects a plan artifact from ExitPlanMode plan_review display', () => {
    const detection = detectArtifactStart(
      toolCallStarted({
        name: 'ExitPlanMode',
        toolCallId: 'tc-plan',
        args: {},
        display: { kind: 'plan_review', plan: '# 计划\n\n第一步', path: '/tmp/plan.md' },
      }),
    )

    expect(detection).toEqual({
      kind: 'plan',
      key: 'plan',
      title: 'plan.md',
      content: '# 计划\n\n第一步',
      toolCallId: 'tc-plan',
      append: false,
    })
  })

  it('falls back to a generic plan title when the plan file path is absent', () => {
    const detection = detectArtifactStart(
      toolCallStarted({
        name: 'ExitPlanMode',
        display: { kind: 'plan_review', plan: '计划内容' },
      }),
    )

    expect(detection?.title).toBe('实施计划')
  })

  it('detects a report artifact from a Write call targeting a markdown file', () => {
    const detection = detectArtifactStart(
      toolCallStarted({
        name: 'Write',
        toolCallId: 'tc-write',
        args: { path: 'docs/walkthrough.md', content: '# 走查报告' },
      }),
    )

    expect(detection).toEqual({
      kind: 'report',
      key: 'docs/walkthrough.md',
      title: 'walkthrough.md',
      content: '# 走查报告',
      toolCallId: 'tc-write',
      append: false,
    })
  })

  it('marks append-mode writes so the store concatenates instead of replacing', () => {
    const detection = detectArtifactStart(
      toolCallStarted({
        name: 'Write',
        args: { path: 'docs/report.markdown', content: '补充', mode: 'append' },
      }),
    )

    expect(detection?.append).toBe(true)
  })

  it('ignores non-artifact events and non-markdown writes', () => {
    const cases: Event[] = [
      { type: 'assistant.delta', turnId: 1, delta: '文本', agentId: 'main', sessionId: 's1' } as Event,
      toolCallStarted({ name: 'Write', args: { path: 'src/main.ts', content: 'code' } }),
      toolCallStarted({ name: 'Write', args: { path: 'docs/a.md', content: '   ' } }),
      toolCallStarted({ name: 'Edit', args: { path: 'docs/a.md', content: 'x' } }),
      toolCallStarted({ name: 'ExitPlanMode', args: {} }),
    ]

    for (const event of cases) {
      expect(detectArtifactStart(event)).toBeNull()
    }
  })
})
