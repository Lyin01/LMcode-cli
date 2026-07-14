import { useCallback, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, HelpCircle, X } from 'lucide-react'
import type { QuestionItem, QuestionResult } from '@lmcode-cli/lmcode-sdk'
import { useSessionStore } from '@/stores/session-store'
import type { QuestionRequestPayload } from '@/types'
import {
  areAllQuestionsAnswered,
  buildQuestionResult,
  createQuestionDrafts,
  type QuestionDraft,
} from './question-answer'

export function QuestionDialog() {
  const activeInteraction = useSessionStore((state) => state.pendingInteractions[0])
  if (activeInteraction?.kind !== 'question') return null

  return (
    <QuestionDialogContent
      key={activeInteraction.payload.requestId}
      pendingQuestion={activeInteraction.payload}
    />
  )
}

interface QuestionDialogContentProps {
  readonly pendingQuestion: QuestionRequestPayload
}

function QuestionDialogContent({ pendingQuestion }: QuestionDialogContentProps) {
  const completePendingInteraction = useSessionStore((state) => state.completePendingInteraction)
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>(() =>
    createQuestionDrafts(pendingQuestion.request),
  )
  const [responseError, setResponseError] = useState<string | null>(null)
  const [responding, setResponding] = useState(false)
  const respondingRef = useRef(false)

  const handleRespond = useCallback(
    async (result: QuestionResult) => {
      if (respondingRef.current) return
      respondingRef.current = true
      setResponding(true)
      setResponseError(null)
      try {
        await window.lmcodeAPI.respondQuestion({
          requestId: pendingQuestion.requestId,
          result,
        })
        completePendingInteraction(pendingQuestion.requestId)
      } catch (err) {
        console.error('Failed to respond question:', err)
        setResponseError('无法提交回答，请重试。')
      } finally {
        respondingRef.current = false
        setResponding(false)
      }
    },
    [pendingQuestion.requestId, completePendingInteraction],
  )

  const updateDraft = useCallback((index: number, next: QuestionDraft) => {
    setDrafts((current) => current.map((draft, draftIndex) => (draftIndex === index ? next : draft)))
  }, [])

  const allAnswered = areAllQuestionsAnswered(pendingQuestion.request, drafts)

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void handleRespond(null)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content max-w-[620px]">
          <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-5 py-4">
            <div className="flex items-center gap-2">
              <HelpCircle size={16} className="text-[var(--lm-warning)]" />
              <Dialog.Title className="text-[15px] font-semibold text-[var(--lm-text-primary)]">
                需要你的回答
              </Dialog.Title>
            </div>
            <Dialog.Close
              aria-label="取消提问"
              disabled={responding}
              className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-wait disabled:opacity-50"
            >
              <X size={15} />
            </Dialog.Close>
          </div>

          <Dialog.Description className="sr-only">
            回答当前工具调用提出的全部问题，或取消本次提问。
          </Dialog.Description>

          <div className="divide-y divide-[var(--lm-border)]">
            {pendingQuestion.request.questions.map((question, index) => {
              const draft = drafts[index]
              if (draft === undefined) return null
              return (
                <QuestionField
                  key={`${index}:${question.question}`}
                  index={index}
                  question={question}
                  draft={draft}
                  disabled={responding}
                  onChange={(next) => updateDraft(index, next)}
                />
              )
            })}
          </div>

          <div className="border-t border-[var(--lm-border)] px-5 py-4">
            {responseError !== null ? (
              <p className="mb-3 text-[12px] text-[var(--lm-error)]" role="alert">
                {responseError}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-[var(--lm-text-muted)]">
                {pendingQuestion.request.questions.length} 个问题
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={responding}
                  onClick={() => void handleRespond(null)}
                  className="rounded-lg border border-[var(--lm-border-strong)] px-3.5 py-2 text-[13px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:cursor-wait disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!allAnswered || responding}
                  onClick={() => void handleRespond(buildQuestionResult(pendingQuestion.request, drafts))}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--lm-accent)] px-4 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check size={14} />
                  提交全部
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface QuestionFieldProps {
  readonly index: number
  readonly question: QuestionItem
  readonly draft: QuestionDraft
  readonly disabled: boolean
  readonly onChange: (draft: QuestionDraft) => void
}

function QuestionField({ index, question, draft, disabled, onChange }: QuestionFieldProps) {
  const inputType = question.multiSelect ? 'checkbox' : 'radio'
  const inputName = `question-${index}`

  if (question.options.length === 0) {
    return (
      <section className="px-5 py-4">
        <QuestionHeading index={index} question={question} />
        <textarea
          value={draft.otherText}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, otherSelected: true, otherText: event.target.value })
          }
          placeholder={question.otherLabel ?? '输入回答...'}
          rows={3}
          className="mt-3 w-full resize-y rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[14px] text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none transition-colors focus:border-[var(--lm-accent)] disabled:cursor-wait disabled:opacity-60"
        />
      </section>
    )
  }

  return (
    <section className="px-5 py-4">
      <QuestionHeading index={index} question={question} />
      <div className="mt-3 space-y-2">
        {question.options.map((option) => {
          const selected = draft.selectedLabels.includes(option.label)
          return (
            <label
              key={option.label}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--lm-border-strong)] px-3 py-2.5 transition-colors hover:bg-[var(--lm-bg-hover)] has-[:checked]:border-[var(--lm-accent)]"
            >
              <input
                type={inputType}
                name={inputName}
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  const selectedLabels = question.multiSelect
                    ? selected
                      ? draft.selectedLabels.filter((label) => label !== option.label)
                      : [...draft.selectedLabels, option.label]
                    : [option.label]
                  onChange({
                    ...draft,
                    selectedLabels,
                    otherSelected: question.multiSelect ? draft.otherSelected : false,
                  })
                }}
                className="mt-0.5 accent-[var(--lm-accent)]"
              />
              <span className="min-w-0">
                <span className="block text-[14px] text-[var(--lm-text-primary)]">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--lm-text-muted)]">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          )
        })}

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--lm-border-strong)] px-3 py-2.5 transition-colors hover:bg-[var(--lm-bg-hover)] has-[:checked]:border-[var(--lm-accent)]">
          <input
            type={inputType}
            name={inputName}
            checked={draft.otherSelected}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...draft,
                selectedLabels: question.multiSelect ? draft.selectedLabels : [],
                otherSelected: event.target.checked,
              })
            }
            className="mt-1 accent-[var(--lm-accent)]"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-[var(--lm-text-secondary)]">
              {question.otherLabel ?? '其他'}
            </span>
            {question.otherDescription ? (
              <span className="mt-0.5 block text-[12px] text-[var(--lm-text-muted)]">
                {question.otherDescription}
              </span>
            ) : null}
            <input
              type="text"
              value={draft.otherText}
              disabled={disabled}
              onFocus={() =>
                onChange({
                  ...draft,
                  selectedLabels: question.multiSelect ? draft.selectedLabels : [],
                  otherSelected: true,
                })
              }
              onChange={(event) =>
                onChange({
                  ...draft,
                  selectedLabels: question.multiSelect ? draft.selectedLabels : [],
                  otherSelected: true,
                  otherText: event.target.value,
                })
              }
              placeholder="输入自定义回答..."
              className="mt-2 w-full border-0 border-b border-[var(--lm-border-strong)] bg-transparent px-0 py-1.5 text-[13px] text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none focus:border-[var(--lm-accent)] disabled:cursor-wait disabled:opacity-60"
            />
          </span>
        </label>
      </div>
    </section>
  )
}

interface QuestionHeadingProps {
  readonly index: number
  readonly question: QuestionItem
}

function QuestionHeading({ index, question }: QuestionHeadingProps) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase text-[var(--lm-text-muted)]">
        <span>问题 {index + 1}</span>
        {question.header ? <span>{question.header}</span> : null}
        {question.multiSelect ? <span>可多选</span> : null}
      </div>
      <p className="mt-1 text-[14px] font-medium leading-relaxed text-[var(--lm-text-primary)]">
        {question.question}
      </p>
      {question.body ? (
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--lm-text-muted)]">
          {question.body}
        </p>
      ) : null}
    </div>
  )
}
