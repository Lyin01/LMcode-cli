import { useState, useEffect, useCallback } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, Check, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import {
  THINKING_OPTIONS,
  getStoredThinking,
  setStoredThinking,
  thinkingLabel,
  type ThinkingEffort,
} from '@/lib/thinking'

/**
 * Picks the model's thinking effort. The shared config defaults to "high",
 * which makes deepseek-flash spend minutes per step; the desktop defaults to
 * "medium" and re-applies the chosen level whenever a session becomes active,
 * so turns finish in a sane time and the user stays in control.
 */
export function ThinkingSwitcher() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const [effort, setEffort] = useState<ThinkingEffort>(() => getStoredThinking())
  const [open, setOpen] = useState(false)

  // Re-apply the preferred effort to whatever session is now active. Sessions
  // otherwise inherit config's "high" default on the main side.
  useEffect(() => {
    if (!currentSessionId) return
    window.lmcodeAPI.setThinking(currentSessionId, effort).catch((err) => {
      console.error('Failed to apply thinking level:', err)
    })
  }, [currentSessionId, effort])

  const handleSelect = useCallback(
    async (value: ThinkingEffort) => {
      setEffort(value)
      setStoredThinking(value)
      setOpen(false)
      if (currentSessionId) {
        try {
          await window.lmcodeAPI.setThinking(currentSessionId, value)
        } catch (err) {
          console.error('Failed to set thinking level:', err)
        }
      }
    },
    [currentSessionId],
  )

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          title="思考强度（越高越慢越深入）"
        >
          <Brain size={14} className="text-[var(--lm-text-muted)]" />
          <span>思考 · {thinkingLabel(effort)}</span>
          <ChevronDown
            size={13}
            className={cn('text-[var(--lm-text-muted)] transition-transform', open && 'rotate-180')}
          />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[220px] overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-pop)]"
        >
          <div className="border-b border-[var(--lm-border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">
            思考强度
          </div>
          <div className="p-1">
            {THINKING_OPTIONS.map((opt) => (
              <DropdownMenu.Item
                key={opt.value}
                onSelect={() => handleSelect(opt.value)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none transition-colors',
                  'data-[highlighted]:bg-[var(--lm-bg-hover)]',
                  effort === opt.value ? 'text-[var(--lm-text-primary)]' : 'text-[var(--lm-text-secondary)]',
                )}
              >
                <div className="flex min-w-0 flex-col">
                  <span className={cn('truncate', effort === opt.value && 'font-medium')}>
                    {opt.label}
                  </span>
                  <span className="text-[10px] text-[var(--lm-text-muted)]">{opt.hint}</span>
                </div>
                {effort === opt.value && (
                  <Check size={14} className="ml-auto shrink-0 text-[var(--lm-accent-text)]" />
                )}
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
