import { memo } from 'react'
import { FileText, Image as ImageIcon, X } from 'lucide-react'
import type { UserAttachment } from '@/types'

interface AttachmentStripProps {
  readonly attachments: readonly UserAttachment[]
  readonly onRemove?: (id: string) => void
}

function formatFileSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return ''
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.ceil(sizeBytes / 1024)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

export const AttachmentStrip = memo(function AttachmentStrip({
  attachments,
  onRemove,
}: AttachmentStripProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex max-w-full flex-wrap gap-2" aria-label="消息附件">
      {attachments.map((attachment) => {
        const size = formatFileSize(attachment.sizeBytes)
        const details = [size, attachment.truncated ? '已截断' : ''].filter(Boolean).join(' · ')
        const canPreview =
          attachment.kind === 'image' &&
          attachment.previewUrl?.startsWith('data:image/') === true

        return (
          <div
            key={attachment.id}
            className="group relative flex max-w-56 items-center gap-2 overflow-hidden rounded-xl border border-[var(--lm-border-strong)] bg-[var(--lm-bg-elevated)] p-1.5"
          >
            {canPreview ? (
              <img
                src={attachment.previewUrl}
                alt={attachment.name}
                className="h-12 w-16 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--lm-bg-hover)] text-[var(--lm-text-muted)]">
                {attachment.kind === 'image' ? <ImageIcon size={18} /> : <FileText size={18} />}
              </span>
            )}

            <span className="min-w-0 pr-1">
              <span className="block truncate text-[12px] font-medium text-[var(--lm-text-primary)]">
                {attachment.name}
              </span>
              {details && (
                <span className="mt-0.5 block truncate text-[10px] text-[var(--lm-text-muted)]">
                  {details}
                </span>
              )}
            </span>

            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="absolute right-1 top-1 rounded-md bg-[var(--lm-bg-elevated)]/90 p-1 text-[var(--lm-text-muted)] opacity-0 shadow-sm transition-opacity hover:text-[var(--lm-error)] group-hover:opacity-100 group-focus-within:opacity-100"
                title={`移除 ${attachment.name}`}
                aria-label={`移除附件 ${attachment.name}`}
              >
                <X size={11} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
})
