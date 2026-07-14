import { useCallback, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useSessionStore } from '@/stores/session-store'
import { X, Terminal } from 'lucide-react'
import type { ApprovalResponse } from '@lmcode-cli/lmcode-sdk'
import type { ApprovalRequestPayload } from '@/types'

export function ApprovalDialog() {
  const activeInteraction = useSessionStore((state) => state.pendingInteractions[0])
  if (activeInteraction?.kind !== 'approval') return null

  return (
    <ApprovalDialogContent
      key={activeInteraction.payload.requestId}
      pendingApproval={activeInteraction.payload}
    />
  )
}

interface ApprovalDialogContentProps {
  readonly pendingApproval: ApprovalRequestPayload
}

function ApprovalDialogContent({ pendingApproval }: ApprovalDialogContentProps) {
  const completePendingInteraction = useSessionStore((state) => state.completePendingInteraction)
  const [responseError, setResponseError] = useState<string | null>(null)
  const [responding, setResponding] = useState(false)
  const respondingRef = useRef(false)

  const handleRespond = useCallback(
    async (response: ApprovalResponse) => {
      if (respondingRef.current) return
      respondingRef.current = true
      setResponding(true)
      setResponseError(null)
      try {
        await window.lmcodeAPI.respondApproval({
          requestId: pendingApproval.requestId,
          response,
        })
        completePendingInteraction(pendingApproval.requestId)
      } catch (err) {
        console.error('Failed to respond approval:', err)
        setResponseError('无法提交审批结果，请重试。')
      } finally {
        respondingRef.current = false
        setResponding(false)
      }
    },
    [pendingApproval, completePendingInteraction],
  )

  const toolName = pendingApproval.request.toolName
  const description = pendingApproval.request.action
  const args = approvalDisplayPreview(pendingApproval.request.display)

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void handleRespond({ decision: 'cancelled' })
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content className="dialog-content data-[state=open]:animate-in data-[state=closed]:animate-out">
          <div className="p-5">
            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-[var(--lm-accent-text)]" />
                <Dialog.Title className="text-[15px] font-semibold text-[var(--lm-text-primary)]">
                  工具调用审批
                </Dialog.Title>
              </div>
              <Dialog.Close
                aria-label="取消审批"
                disabled={responding}
                className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-wait disabled:opacity-50"
              >
                <X size={15} />
              </Dialog.Close>
            </div>

            {/* Tool info */}
            <div className="mb-3">
              <span className="text-[12px] text-[var(--lm-text-muted)]">工具:</span>
              <span className="ml-2 text-[14px] font-medium text-[var(--lm-text-primary)]">{toolName}</span>
            </div>

            {/* Description */}
            {description && (
              <div className="mb-3">
                <span className="text-[12px] text-[var(--lm-text-muted)]">描述:</span>
                <p className="mt-0.5 text-[14px] text-[var(--lm-text-secondary)]">{description}</p>
              </div>
            )}

            {/* Args */}
            {Object.keys(args).length > 0 && (
              <div className="mb-4">
                <span className="text-[12px] text-[var(--lm-text-muted)]">参数:</span>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-code)] p-2.5 font-mono text-[12px] text-[var(--lm-text-secondary)]">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>
            )}

            {responseError !== null ? (
              <p className="mb-3 text-[12px] text-[var(--lm-error)]" role="alert">
                {responseError}
              </p>
            ) : null}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => handleRespond({ decision: 'rejected' })}
                disabled={responding}
                className="rounded-lg border border-[var(--lm-border-strong)] px-3.5 py-2 text-[13px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:cursor-wait disabled:opacity-50"
              >
                拒绝
              </button>
              <button
                onClick={() => handleRespond({ decision: 'approved' })}
                disabled={responding}
                className="rounded-lg bg-[var(--lm-accent)] px-3.5 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:cursor-wait disabled:opacity-50"
              >
                允许一次
              </button>
              <button
                onClick={() => handleRespond({ decision: 'approved', scope: 'session' })}
                disabled={responding}
                className="rounded-lg border border-[var(--lm-border-strong)] px-3.5 py-2 text-[13px] font-medium text-[var(--lm-text-primary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:cursor-wait disabled:opacity-50"
              >
                始终允许
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function approvalDisplayPreview(
  display: ApprovalRequestPayload['request']['display'],
): Record<string, unknown> {
  switch (display.kind) {
    case 'command':
      return {
        command: display.command,
        cwd: display.cwd,
      }
    case 'file_io':
      return {
        operation: display.operation,
        path: display.path,
        detail: display.detail,
      }
    case 'generic':
      return typeof display.detail === 'object' && display.detail !== null
        ? (display.detail as Record<string, unknown>)
        : { summary: display.summary }
    default:
      return display
  }
}
