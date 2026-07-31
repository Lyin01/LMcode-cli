import { useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, Folder, FolderOpen, FolderX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore, type NewSessionTarget } from '@/stores/session-store'
import { collectProjects, truncateProjectPath } from '@/lib/projects'
import { greeting } from '@/lib/greeting'

const NO_PROJECT_LABEL = '不在项目中工作'

/**
 * Codex-style welcome screen shown whenever no session is selected (app
 * launch, "新建对话"). The user picks where the next conversation lives —
 * a recent project, a folder chosen through the system dialog, or the
 * no-project sentinel workspace — and the session is only created when the
 * first message is submitted.
 */
export function WelcomeScreen() {
  const sessions = useSessionStore((s) => s.sessions)
  const noProjectWorkDir = useSessionStore((s) => s.noProjectWorkDir)
  const startSessionWithMessage = useSessionStore((s) => s.startSessionWithMessage)

  const projects = useMemo(
    () => collectProjects(sessions, noProjectWorkDir),
    [sessions, noProjectWorkDir],
  )

  // null = "not chosen yet": fall back to the most recent project, or to the
  // no-project workspace when there is no project history.
  const [chosenTarget, setChosenTarget] = useState<NewSessionTarget | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const target: NewSessionTarget =
    chosenTarget ??
    (projects[0]
      ? { kind: 'project', workDir: projects[0].workDir }
      : { kind: 'no-project' })

  const targetLabel =
    target.kind === 'no-project' ? NO_PROJECT_LABEL : truncateProjectPath(target.workDir)

  const autoGrow = (): void => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }

  const handlePickFolder = async (): Promise<void> => {
    setPickerOpen(false)
    const workDir = await window.lmcodeAPI.selectWorkDirectory()
    if (workDir) setChosenTarget({ kind: 'project', workDir })
  }

  const handleSubmit = (): void => {
    const text = draft.trim()
    if (!text || starting) return
    setStarting(true)
    // The store adopts the new session (which unmounts this screen) and queues
    // the message; the composer's queue drain sends it once the chat mounts.
    void startSessionWithMessage(target, text).finally(() => setStarting(false))
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6">
      <div className="w-full max-w-2xl pb-10">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--lm-accent-soft)] text-2xl font-bold text-[var(--lm-accent-text)]">
            L
          </div>
          <h2
            className="text-3xl font-normal tracking-tight text-[var(--lm-text-primary)]"
            style={{ fontFamily: 'var(--lm-font-serif)' }}
          >
            {greeting()}，今天想做点什么？
          </h2>
          <p className="text-[13px] text-[var(--lm-text-muted)]">
            LMCODE · AI Agent 桌面客户端
          </p>
        </div>

        {/* Session target picker */}
        <div className="relative mb-2 flex">
          <button
            type="button"
            onClick={() => setPickerOpen((value) => !value)}
            title={target.kind === 'project' ? target.workDir : NO_PROJECT_LABEL}
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            aria-label={`对话位置：${targetLabel}`}
            className="flex max-w-56 items-center gap-2 rounded-full border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            {target.kind === 'no-project' ? (
              <FolderX size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
            ) : (
              <Folder size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
            )}
            <span className="min-w-0 flex-1 truncate text-left font-medium">{targetLabel}</span>
            <ChevronDown
              size={13}
              className={cn('shrink-0 transition-transform', pickerOpen && 'rotate-180')}
            />
          </button>
          {pickerOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 cursor-default bg-transparent"
                onClick={() => setPickerOpen(false)}
                aria-label="关闭项目列表"
                tabIndex={-1}
              />
              <div
                role="menu"
                aria-label="选择对话位置"
                className="absolute left-0 top-full z-50 mt-1 max-h-64 w-72 overflow-y-auto rounded-xl border border-[var(--lm-border-strong)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-soft)]"
              >
                {projects.length === 0 && (
                  <p className="px-2.5 py-2 text-[11px] text-[var(--lm-text-muted)]">
                    暂无最近项目
                  </p>
                )}
                {projects.map((project) => (
                  <button
                    key={project.workDir}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChosenTarget({ kind: 'project', workDir: project.workDir })
                      setPickerOpen(false)
                    }}
                    title={project.workDir}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors',
                      target.kind === 'project' && project.workDir === target.workDir
                        ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]'
                        : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {truncateProjectPath(project.workDir)}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--lm-text-muted)]">
                      {project.sessionCount}
                    </span>
                    {target.kind === 'project' && project.workDir === target.workDir && (
                      <Check size={13} className="shrink-0 text-[var(--lm-accent-text)]" />
                    )}
                  </button>
                ))}
                <div className="my-1 border-t border-[var(--lm-border)]" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handlePickFolder()}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                >
                  <FolderOpen size={13} className="shrink-0" />
                  <span>选择文件夹…</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setChosenTarget({ kind: 'no-project' })
                    setPickerOpen(false)
                  }}
                  title="会话不绑定任何项目目录，文件操作限定在独立的工作区"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors',
                    target.kind === 'no-project'
                      ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]'
                      : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
                  )}
                >
                  <FolderX size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1">{NO_PROJECT_LABEL}</span>
                  {target.kind === 'no-project' && (
                    <Check size={13} className="shrink-0 text-[var(--lm-accent-text)]" />
                  )}
                </button>
              </div>
            </>
          )}
        </div>

        {/* First-message composer */}
        <div className="rounded-[20px] border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] shadow-[var(--lm-shadow-soft)] transition-colors focus-within:border-[var(--lm-accent)]">
          <textarea
            ref={textareaRef}
            value={draft}
            autoFocus
            onChange={(event) => {
              setDraft(event.target.value)
              autoGrow()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="给 LMCODE 发消息，开始新的对话…"
            rows={1}
            className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-relaxed text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none"
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
            <span className="truncate px-1.5 text-[11px] text-[var(--lm-text-muted)]">
              {target.kind === 'no-project'
                ? '会话不绑定项目目录'
                : `在 ${targetLabel} 中开始`}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!draft.trim() || starting}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-accent)] text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
              title={starting ? '正在创建会话…' : '发送'}
              aria-label="发送消息"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
