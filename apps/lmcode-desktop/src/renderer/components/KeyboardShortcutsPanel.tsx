import { useEffect, useRef } from 'react'
import { Keyboard, X } from 'lucide-react'

interface KeyboardShortcutsPanelProps {
  open: boolean
  onClose: () => void
}

interface ShortcutDefinition {
  readonly label: string
  readonly keys: readonly string[]
}

interface ShortcutSection {
  readonly title: string
  readonly shortcuts: readonly ShortcutDefinition[]
}

const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    title: '开始与导航',
    shortcuts: [
      { label: '新建对话', keys: ['mod', 'N'] },
      { label: '打开项目', keys: ['mod', 'O'] },
      { label: '搜索对话', keys: ['mod', 'K'] },
      { label: '命令面板', keys: ['mod', 'Shift', 'P'] },
      { label: '上一个 / 下一个对话', keys: ['mod', 'PageUp / PageDown'] },
    ],
  },
  {
    title: '当前对话',
    shortcuts: [
      { label: '在对话中查找', keys: ['mod', 'F'] },
      { label: '查找下一个', keys: ['mod', 'G'] },
      { label: '切换权限模式', keys: ['Shift', 'Tab'] },
      { label: '重命名对话', keys: ['F2'] },
      { label: '导出对话', keys: ['mod', 'Shift', 'E'] },
    ],
  },
  {
    title: '界面',
    shortcuts: [
      { label: '显示 / 隐藏侧栏', keys: ['mod', 'B'] },
      { label: '项目终端', keys: ['mod', 'J'] },
      { label: 'Git 变更', keys: ['mod', 'Shift', 'G'] },
      { label: '设置', keys: ['mod', ','] },
      { label: '全屏', keys: ['F11'] },
    ],
  },
]

export function KeyboardShortcutsPanel({
  open,
  onClose,
}: KeyboardShortcutsPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [onClose, open])

  if (!open) return null

  const modifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'

  return (
    <div
      className="fixed inset-x-0 top-0 bottom-[var(--lm-global-usage-height)] z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--lm-border-strong)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-soft)]"
      >
        <header className="flex items-center gap-3 border-b border-[var(--lm-border)] px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--lm-accent-soft)] text-[var(--lm-accent-text)]">
            <Keyboard size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="keyboard-shortcuts-title"
              className="text-[15px] font-semibold text-[var(--lm-text-primary)]"
            >
              键盘快捷键
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--lm-text-muted)]">
              菜单与界面共用同一套快捷键
            </p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="关闭"
            aria-label="关闭键盘快捷键"
          >
            <X size={17} />
          </button>
        </header>

        <div className="grid max-h-[70vh] gap-5 overflow-y-auto p-5 sm:grid-cols-2">
          {SHORTCUT_SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--lm-text-muted)]">
                {section.title}
              </h3>
              <div className="overflow-hidden rounded-xl border border-[var(--lm-border)]">
                {section.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.label}
                    className="flex min-h-10 items-center gap-3 border-b border-[var(--lm-border)] px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 text-[12px] text-[var(--lm-text-secondary)]">
                      {shortcut.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <kbd
                          key={key}
                          className="min-w-6 rounded-md border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-1.5 py-0.5 text-center font-mono text-[10px] text-[var(--lm-text-primary)] shadow-sm"
                        >
                          {key === 'mod' ? modifier : key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
