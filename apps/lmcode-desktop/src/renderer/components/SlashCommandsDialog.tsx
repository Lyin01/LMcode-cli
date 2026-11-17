import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCandidate, SlashCommandSource } from '@/lib/slash-command'
import {
  Target,
  Cpu,
  Eraser,
  HelpCircle,
  ListChecks,
  Archive,
  Undo2,
  ScanSearch,
  Sparkles,
  Zap,
} from 'lucide-react'

interface SlashCommandsDialogProps {
  /** Ranked candidates after the query filter. */
  matches: readonly SlashCandidate[]
  /** Highlighted row index into `matches` (owned by the composer). */
  selectedIndex: number
  /** Current query after "/" — used for the empty hint. */
  query: string
  /** Pointer hover moves the highlight; the composer keeps it in sync. */
  onHover: (index: number) => void
  /** Clicking a row accepts it the same way Enter does. */
  onSelect: (candidate: SlashCandidate) => void
}

const COMMAND_ICONS: Record<string, React.ReactNode> = {
  goal: <Target size={14} />,
  plan: <ListChecks size={14} />,
  review: <ScanSearch size={14} />,
  model: <Cpu size={14} />,
  compact: <Archive size={14} />,
  revoke: <Undo2 size={14} />,
  clear: <Eraser size={14} />,
  help: <HelpCircle size={14} />,
}

const GROUP_LABELS: Record<SlashCommandSource, string> = {
  builtin: '命令',
  skill: '技能',
}

function iconFor(candidate: SlashCandidate): React.ReactNode {
  if (candidate.source === 'skill') return <Zap size={14} />
  return COMMAND_ICONS[candidate.id] ?? <Sparkles size={14} />
}

export function SlashCommandsDialog({
  matches,
  selectedIndex,
  query,
  onHover,
  onSelect,
}: SlashCommandsDialogProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const skillCount = matches.reduce(
    (count, item) => count + (item.source === 'skill' ? 1 : 0),
    0,
  )

  // Keep the highlighted row visible while the user arrows through a long list.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const row = list.querySelector<HTMLElement>(`[data-slash-index="${selectedIndex}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, matches.length])

  return (
    <div
      className={cn(
        'absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl',
        'border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-pop)]',
        'animate-fade-in',
      )}
      data-ui="slash-palette"
    >
      {matches.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-[var(--lm-text-muted)]">
          没有匹配 “<span className="text-[var(--lm-text-secondary)]">{query}</span>” 的命令
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            className="max-h-[260px] overflow-y-auto p-1"
            role="listbox"
            aria-label="斜杠命令列表"
            aria-activedescendant={
              matches[selectedIndex] ? `slash-option-${selectedIndex}` : undefined
            }
          >
            {matches.map((candidate, index) => {
              const previous = matches[index - 1]
              const showGroup = !previous || previous.source !== candidate.source
              return (
                <div key={candidate.id}>
                  {showGroup && (
                    <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">
                      {GROUP_LABELS[candidate.source]}
                      {candidate.source === 'skill' ? ` · ${skillCount}` : ''}
                    </div>
                  )}
                  <button
                    type="button"
                    id={`slash-option-${index}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    data-slash-index={index}
                    onMouseDown={(event) => {
                      // Keep focus in the textarea; click should not blur it first.
                      event.preventDefault()
                    }}
                    onMouseEnter={() => onHover(index)}
                    onClick={() => onSelect(candidate)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors',
                      index === selectedIndex
                        ? 'bg-[var(--lm-bg-hover)] text-[var(--lm-text-primary)]'
                        : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
                    )}
                  >
                    <span className="shrink-0 text-[var(--lm-text-muted)]">
                      {iconFor(candidate)}
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-[var(--lm-text-primary)]">
                        {candidate.label}
                      </span>
                      <span className="truncate text-[11px] text-[var(--lm-text-muted)]">
                        {candidate.description}
                      </span>
                    </div>
                    {candidate.source === 'skill' && (
                      <span className="ml-auto shrink-0 rounded-full bg-[var(--lm-bg-active)] px-1.5 py-0.5 text-[9px] text-[var(--lm-text-muted)]">
                        技能
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--lm-border)] px-3 py-1.5 text-[10px] text-[var(--lm-text-muted)]">
            <span>↑↓ 选择</span>
            <span className="opacity-40">·</span>
            <span>Tab 补全</span>
            <span className="opacity-40">·</span>
            <span>Enter 执行</span>
            <span className="opacity-40">·</span>
            <span>Esc 关闭</span>
            <span className="ml-auto">{matches.length} 项</span>
          </div>
        </>
      )}
    </div>
  )
}
