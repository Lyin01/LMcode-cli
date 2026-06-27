import { useState, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import {
  Target,
  Cpu,
  Shield,
  Settings,
  Eraser,
  Download,
  HelpCircle,
} from 'lucide-react'

export interface SlashCommand {
  id: string
  label: string
  description: string
  icon: React.ReactNode
  action: () => void
}

interface SlashCommandsDialogProps {
  /** Currently typed query (after "/") for filtering */
  query: string
  /** Callback when a command is selected */
  onSelect: (command: SlashCommand) => void
  /** Callback to close the dialog */
  onClose: () => void
}

export function SlashCommandsDialog({
  query,
  onSelect,
  onClose,
}: SlashCommandsDialogProps) {
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands: SlashCommand[] = [
    {
      id: 'goal',
      label: '/goal',
      description: '开启自主目标循环',
      icon: <Target size={14} />,
      action: () => {
        // /goal - start autonomous goal loop (future feature)
        console.log('Slash command: /goal')
      },
    },
    {
      id: 'model',
      label: '/model',
      description: '切换模型',
      icon: <Cpu size={14} />,
      action: () => {
        // /model - triggers model switcher UI (handled by parent)
        console.log('Slash command: /model')
      },
    },
    {
      id: 'mode',
      label: '/mode',
      description: '切换权限模式',
      icon: <Shield size={14} />,
      action: () => {
        // /mode - switch permission mode
        console.log('Slash command: /mode')
      },
    },
    {
      id: 'config',
      label: '/config',
      description: '打开设置面板',
      icon: <Settings size={14} />,
      action: () => {
        // /config - open settings (handled by parent)
        console.log('Slash command: /config')
      },
    },
    {
      id: 'clear',
      label: '/clear',
      description: '清除对话',
      icon: <Eraser size={14} />,
      action: () => {
        clearMessages()
      },
    },
    {
      id: 'export',
      label: '/export',
      description: '导出会话',
      icon: <Download size={14} />,
      action: () => {
        console.log('Slash command: /export')
      },
    },
    {
      id: 'help',
      label: '/help',
      description: '显示帮助',
      icon: <HelpCircle size={14} />,
      action: () => {
        console.log('Slash command: /help')
      },
    },
  ]

  const filtered = query
    ? commands.filter(
        (cmd) =>
          cmd.id.includes(query.toLowerCase()) ||
          cmd.label.includes(query.toLowerCase()) ||
          cmd.description.includes(query),
      )
    : commands

  // Reset selected index when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
        case 'Tab':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % filtered.length)
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length)
          break
        case 'Enter':
          e.preventDefault()
          if (filtered[selectedIndex]) {
            onSelect(filtered[selectedIndex]!)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  )

  // Attach global keyboard listener when dialog is open
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleClick = useCallback(
    (cmd: SlashCommand) => {
      onSelect(cmd)
    },
    [onSelect],
  )

  if (filtered.length === 0) return null

  return (
    <div
      className={cn(
        'absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl',
        'border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-pop)]',
        'animate-fade-in',
      )}
    >
      <div className="border-b border-[var(--lm-border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">
        命令
      </div>
      <div
        ref={listRef}
        className="max-h-[220px] overflow-y-auto p-1"
        role="listbox"
        aria-label="斜杠命令列表"
      >
        {filtered.map((cmd, index) => (
          <button
            key={cmd.id}
            role="option"
            aria-selected={index === selectedIndex}
            onClick={() => handleClick(cmd)}
            onMouseEnter={() => setSelectedIndex(index)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none transition-colors',
              index === selectedIndex
                ? 'bg-[var(--lm-bg-hover)] text-[var(--lm-text-primary)]'
                : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
            )}
          >
            <span className="shrink-0 text-[var(--lm-text-muted)]">{cmd.icon}</span>
            <div className="flex flex-col">
              <span className="font-medium text-[var(--lm-text-primary)]">{cmd.label}</span>
              <span className="text-[11px] text-[var(--lm-text-muted)]">{cmd.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
