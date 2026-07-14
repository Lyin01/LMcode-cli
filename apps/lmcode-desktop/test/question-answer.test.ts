import { describe, expect, it } from 'vitest'
import type { QuestionRequest } from '@lmcode-cli/lmcode-sdk'
import {
  areAllQuestionsAnswered,
  buildQuestionResult,
  createQuestionDrafts,
  type QuestionDraft,
} from '../src/renderer/components/dialogs/question-answer'

const request: QuestionRequest = {
  questions: [
    {
      question: 'Runtime?',
      header: 'Runtime',
      options: [{ label: 'Node.js' }, { label: 'Bun' }],
    },
    {
      question: 'Features?',
      multiSelect: true,
      options: [{ label: 'Streaming' }, { label: 'Tools' }],
    },
    {
      question: 'Notes?',
      options: [],
    },
  ],
}

describe('desktop question answers', () => {
  it('maps every question by its text and preserves multi-select semantics', () => {
    const drafts: QuestionDraft[] = [
      { selectedLabels: ['Bun'], otherSelected: false, otherText: '' },
      { selectedLabels: ['Streaming', 'Tools'], otherSelected: true, otherText: 'Tracing' },
      { selectedLabels: [], otherSelected: true, otherText: 'Ship it' },
    ]

    expect(areAllQuestionsAnswered(request, drafts)).toBe(true)
    expect(buildQuestionResult(request, drafts)).toEqual({
      answers: {
        'Runtime?': 'Bun',
        'Features?': 'Streaming, Tools, Tracing',
        'Notes?': 'Ship it',
      },
      method: 'enter',
    })
  })

  it('requires all questions and lets a custom single-select answer replace presets', () => {
    const incomplete = createQuestionDrafts(request)
    expect(areAllQuestionsAnswered(request, incomplete)).toBe(false)

    const customDrafts: QuestionDraft[] = [
      { selectedLabels: [], otherSelected: true, otherText: 'Deno' },
      { selectedLabels: ['Tools'], otherSelected: false, otherText: '' },
      { selectedLabels: [], otherSelected: true, otherText: 'No notes' },
    ]
    expect(buildQuestionResult(request, customDrafts)).toMatchObject({
      answers: { 'Runtime?': 'Deno' },
    })
  })
})
