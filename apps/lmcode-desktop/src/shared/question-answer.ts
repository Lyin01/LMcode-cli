import type { QuestionItem, QuestionRequest, QuestionResult } from '@lmcode-cli/lmcode-sdk'

export interface QuestionDraft {
  readonly selectedLabels: readonly string[]
  readonly otherSelected: boolean
  readonly otherText: string
}

export function createQuestionDrafts(request: QuestionRequest): QuestionDraft[] {
  return request.questions.map(() => ({
    selectedLabels: [],
    otherSelected: false,
    otherText: '',
  }))
}

export function questionAnswer(question: QuestionItem, draft: QuestionDraft): string | null {
  const otherText = draft.otherText.trim()
  if (question.options.length === 0) return otherText.length > 0 ? otherText : null

  if (!question.multiSelect) {
    if (draft.otherSelected) return otherText.length > 0 ? otherText : null
    return draft.selectedLabels[0] ?? null
  }

  const answers = [...draft.selectedLabels]
  if (draft.otherSelected && otherText.length > 0) answers.push(otherText)
  return answers.length > 0 ? answers.join(', ') : null
}

export function areAllQuestionsAnswered(
  request: QuestionRequest,
  drafts: readonly QuestionDraft[],
): boolean {
  return request.questions.every((question, index) => {
    const draft = drafts[index]
    return draft !== undefined && questionAnswer(question, draft) !== null
  })
}

export function buildQuestionResult(
  request: QuestionRequest,
  drafts: readonly QuestionDraft[],
): QuestionResult {
  const answers: Record<string, string | true> = {}
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]
    const draft = drafts[index]
    if (question === undefined || draft === undefined) continue

    const answer = questionAnswer(question, draft)
    if (answer !== null) answers[question.question] = answer
  }

  return Object.keys(answers).length > 0 ? { answers, method: 'enter' } : null
}
