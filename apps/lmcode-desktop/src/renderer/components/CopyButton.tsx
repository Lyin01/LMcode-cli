import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

type TimerId = number

/**
 * Small "copy to clipboard" button shared by the settings remote panel and the
 * remote connect dialog. Shows a transient check mark after a successful copy;
 * clipboard failures are ignored (some sandboxed contexts deny access).
 */
export function CopyButton({
  text,
  label,
  className = 'lm-settings-action',
}: {
  readonly text: string
  readonly label: string
  readonly className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<TimerId | null>(null)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard may be unavailable in some sandboxed contexts.
    }
  }
  return (
    <button type="button" className={className} onClick={() => void copy()} aria-label={label}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}
