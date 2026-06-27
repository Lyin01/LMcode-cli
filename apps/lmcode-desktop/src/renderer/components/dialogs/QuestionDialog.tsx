import { useState, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useSessionStore } from '@/stores/session-store'
import { X, HelpCircle } from 'lucide-react'

export function QuestionDialog() {
  const pendingQuestion = useSessionStore((s) => s.pendingQuestion)
  const setPendingQuestion = useSessionStore((s) => s.setPendingQuestion)
  const [textAnswer, setTextAnswer] = useState('')

  const handleSubmit = useCallback(async () => {
    if (!pendingQuestion) return

    try {
      await window.lmcodeAPI.respondQuestion({
        requestId: pendingQuestion.requestId,
        answers: { [pendingQuestion.questionId ?? '0']: textAnswer },
      })
    } catch (err) {
      console.error('Failed to respond question:', err)
    }
    setPendingQuestion(null)
    setTextAnswer('')
  }, [pendingQuestion, textAnswer, setPendingQuestion])

  const handleOptionSelect = useCallback(
    async (option: string) => {
      if (!pendingQuestion) return
      try {
        await window.lmcodeAPI.respondQuestion({
          requestId: pendingQuestion.requestId,
          answers: { [pendingQuestion.questionId ?? '0']: option },
        })
      } catch (err) {
        console.error('Failed to respond question:', err)
      }
      setPendingQuestion(null)
    },
    [pendingQuestion, setPendingQuestion],
  )

  if (!pendingQuestion) return null

  const hasOptions = !!(pendingQuestion.options && pendingQuestion.options.length > 0)

  return (
    <Dialog.Root open={!!pendingQuestion} onOpenChange={() => setPendingQuestion(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="p-5">
            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HelpCircle size={16} className="text-[var(--lm-warning)]" />
                <Dialog.Title className="text-[15px] font-semibold text-[var(--lm-text-primary)]">
                  提问
                </Dialog.Title>
              </div>
              <Dialog.Close className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]">
                <X size={15} />
              </Dialog.Close>
            </div>

            {/* Question text */}
            <div className="mb-4">
              <p className="text-[14px] leading-relaxed text-[var(--lm-text-primary)]">
                {pendingQuestion.question ?? pendingQuestion.text ?? pendingQuestion.message ?? ''}
              </p>
            </div>

            {/* Options or text input */}
            {hasOptions ? (
              <div className="flex flex-col gap-1.5">
                {pendingQuestion.options.map((opt: any, idx: number) => (
                  <button
                    key={idx}
                    onClick={() => handleOptionSelect(opt.value ?? opt.label ?? opt)}
                    className="rounded-lg border border-[var(--lm-border-strong)] px-3.5 py-2.5 text-left text-[14px] text-[var(--lm-text-secondary)] transition-colors hover:border-[var(--lm-accent)] hover:bg-[var(--lm-bg-hover)]"
                  >
                    {opt.label ?? opt.value ?? opt}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <textarea
                  value={textAnswer}
                  onChange={(e) => setTextAnswer(e.target.value)}
                  placeholder="输入回答..."
                  rows={3}
                  className="w-full resize-none rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[14px] text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none transition-colors focus:border-[var(--lm-accent)]"
                />
                <div className="flex justify-end">
                  <button
                    onClick={handleSubmit}
                    disabled={!textAnswer.trim()}
                    className="rounded-lg bg-[var(--lm-accent)] px-4 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    提交
                  </button>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
