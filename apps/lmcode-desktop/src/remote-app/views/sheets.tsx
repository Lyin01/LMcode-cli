import { useState } from 'react'
import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionItem,
  QuestionRequest,
  QuestionResult,
} from '@lmcode-cli/lmcode-sdk'
import {
  areAllQuestionsAnswered,
  buildQuestionResult,
  createQuestionDrafts,
  type QuestionDraft,
} from '../../shared/question-answer'
import { describeApproval } from '../format'

export interface ApprovalSheetProps {
  readonly request: ApprovalRequest
  readonly onRespond: (response: ApprovalResponse) => void
}

export function ApprovalSheet({ request, onRespond }: ApprovalSheetProps) {
  const lines = describeApproval(request.display)
  return (
    <div className="rm-sheet-backdrop">
      <div className="rm-sheet" role="dialog" aria-modal="true" aria-label="工具调用审批">
        <div className="rm-sheet-title">工具调用审批</div>
        <div className="rm-sheet-sub">{request.toolName}</div>
        <div className="rm-sheet-action">{request.action}</div>
        {lines.length > 0 && <pre className="rm-sheet-pre">{lines.join('\n')}</pre>}
        <div className="rm-sheet-actions">
          <button className="rm-primary" type="button" onClick={() => onRespond({ decision: 'approved' })}>
            允许
          </button>
          <button
            className="rm-ghost"
            type="button"
            onClick={() => onRespond({ decision: 'approved', scope: 'session' })}
          >
            本会话始终允许
          </button>
          <button className="rm-danger" type="button" onClick={() => onRespond({ decision: 'rejected' })}>
            拒绝
          </button>
        </div>
      </div>
    </div>
  )
}

export interface QuestionSheetProps {
  readonly request: QuestionRequest
  readonly onSubmit: (result: QuestionResult) => void
}

export function QuestionSheet({ request, onSubmit }: QuestionSheetProps) {
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>(() => createQuestionDrafts(request))
  const canSubmit = areAllQuestionsAnswered(request, drafts)

  const updateDraft = (index: number, next: QuestionDraft): void => {
    setDrafts((previous) => previous.map((draft, position) => (position === index ? next : draft)))
  }

  return (
    <div className="rm-sheet-backdrop">
      <div className="rm-sheet" role="dialog" aria-modal="true" aria-label="需要你的回答">
        <div className="rm-sheet-title">需要你的回答</div>
        {request.questions.map((question, index) => (
          <QuestionBlock
            key={`${index}-${question.question}`}
            question={question}
            draft={drafts[index] ?? { selectedLabels: [], otherSelected: false, otherText: '' }}
            onChange={(next) => updateDraft(index, next)}
          />
        ))}
        <div className="rm-sheet-actions">
          <button
            className="rm-primary"
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              const result = buildQuestionResult(request, drafts)
              if (result !== null) onSubmit(result)
            }}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  )
}

function QuestionBlock({
  question,
  draft,
  onChange,
}: {
  readonly question: QuestionItem
  readonly draft: QuestionDraft
  readonly onChange: (next: QuestionDraft) => void
}) {
  const multiSelect = question.multiSelect === true
  const otherVisible = question.otherLabel !== undefined || question.options.length === 0

  return (
    <div className="rm-question">
      {question.header !== undefined && question.header.length > 0 && (
        <div className="rm-question-header">{question.header}</div>
      )}
      <div className="rm-question-text">{question.question}</div>
      {question.body !== undefined && question.body.length > 0 && (
        <p className="rm-muted">{question.body}</p>
      )}
      {question.options.length > 0 && (
        <div className="rm-options">
          {question.options.map((option) => {
            const selected = draft.selectedLabels.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                className={selected ? 'rm-option rm-option-selected' : 'rm-option'}
                onClick={() => {
                  if (multiSelect) {
                    onChange({
                      ...draft,
                      selectedLabels: selected
                        ? draft.selectedLabels.filter((label) => label !== option.label)
                        : [...draft.selectedLabels, option.label],
                    })
                    return
                  }
                  onChange({ ...draft, selectedLabels: [option.label], otherSelected: false })
                }}
              >
                <span className="rm-option-label">{option.label}</span>
                {option.description !== undefined && option.description.length > 0 && (
                  <span className="rm-option-desc">{option.description}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {otherVisible && (
        <div className="rm-other">
          <div className="rm-other-label">{question.otherLabel ?? '其他回答'}</div>
          <input
            className="rm-input"
            value={draft.otherText}
            placeholder="输入你的回答"
            onChange={(event) => {
              const text = event.target.value
              onChange({
                ...draft,
                otherText: text,
                otherSelected: text.trim().length > 0,
                ...(multiSelect ? {} : { selectedLabels: text.trim().length > 0 ? [] : draft.selectedLabels }),
              })
            }}
          />
        </div>
      )}
    </div>
  )
}
