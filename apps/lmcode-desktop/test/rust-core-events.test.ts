import { describe, expect, it } from 'vitest'
import {
  approvalFromReverse,
  createTranslateState,
  promptToText,
  questionFromReverse,
  translateNotification,
} from '../src/main/rust-core/events'

describe('app-server notification translation', () => {
  it('maps turn, tool, and interrupted completion onto renderer events', () => {
    const state = createTranslateState()
    const started = translateNotification(
      'turn/started',
      { turnId: 'turn_a' },
      state,
      'sess',
    )
    expect(started).toMatchObject({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: 'sess',
    })

    const tool = translateNotification(
      'item/tool/started',
      { turnId: 'turn_a', tool: 'Bash', arguments: '{"command":"echo hi"}' },
      state,
      'sess',
    )
    expect(tool).toMatchObject({
      type: 'tool.call.started',
      turnId: 1,
      name: 'Bash',
      args: { command: 'echo hi' },
    })

    const result = translateNotification(
      'item/tool/completed',
      { turnId: 'turn_a', tool: 'Bash', ok: false, result: 'denied' },
      state,
      'sess',
    )
    expect(result).toMatchObject({
      type: 'tool.result',
      toolCallId: (tool as { toolCallId: string }).toolCallId,
      output: 'denied',
      isError: true,
    })

    const ended = translateNotification(
      'turn/completed',
      { turnId: 'turn_a', status: 'interrupted', error: 'stopped' },
      state,
      'sess',
    )
    expect(ended).toMatchObject({
      type: 'turn.ended',
      turnId: 1,
      reason: 'cancelled',
      error: { code: 'UNKNOWN', message: 'stopped', retryable: false },
    })

    const fired = translateNotification(
      'cron/fired',
      {
        threadId: 'sess',
        prompt: 'ping the build',
        origin: {
          kind: 'cron_job',
          jobId: 'duejob01',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
      state,
      'sess',
    )
    expect(fired).toEqual({
      type: 'cron.fired',
      prompt: 'ping the build',
      origin: {
        kind: 'cron_job',
        jobId: 'duejob01',
        cron: '* * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
      agentId: 'main',
      sessionId: 'sess',
    })
  })

  it('maps bash approval and question reverse requests', () => {
    const state = createTranslateState()
    const approval = approvalFromReverse(
      {
        turnId: 'turn_b',
        tool: 'Bash',
        arguments: '{"command":"echo hi"}',
      },
      state,
    )
    expect(approval.toolName).toBe('Bash')
    expect(approval.display).toEqual({ kind: 'command', command: 'echo hi' })

    const question = questionFromReverse(
      {
        turnId: 'turn_b',
        questions: [
          {
            question: 'Which?',
            header: 'Pick',
            options: [{ label: 'A', description: 'one' }],
          },
        ],
      },
      state,
    )
    expect(question.turnId).toBe(1)
    expect(question.questions).toEqual([
      {
        question: 'Which?',
        header: 'Pick',
        multiSelect: false,
        options: [{ label: 'A', description: 'one' }],
      },
    ])
  })

  it('turns an image-only prompt into a visible placeholder', () => {
    expect(promptToText('hello')).toBe('hello')
    expect(promptToText([{ type: 'text', text: 'hello' }])).toBe('hello')
    expect(
      promptToText([{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,aa' } }]),
    ).toBe('[image attachment]')
  })
})
