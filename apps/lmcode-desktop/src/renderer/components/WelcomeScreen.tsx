import { useMemo, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore, type NewSessionTarget } from '@/stores/session-store'
import {
  collectProjects,
  projectDisplayName,
  truncateProjectPath,
} from '@/lib/projects'
import { AgentWelcome } from '@/components/AgentWelcome'
import { ModelSwitcher } from '@/components/ModelSwitcher'
import { ThinkingSwitcher } from '@/components/ThinkingSwitcher'
import { AttachmentStrip } from '@/components/AttachmentStrip'
import { defaultPastedImageName } from '@/lib/pasted-image-name'
import { fileToDataUrl } from '@/lib/file-to-data-url'
import { MAX_PROMPT_ATTACHMENTS, type FileAttachmentPreview } from '../../shared/file-types'
import type { UserAttachment } from '@/types'

const NO_PROJECT_LABEL = '不关联项目'
const targetMenuItemClass =
  'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]'

/**
 * Start surface for a new task. The project, model, prompt and submit action
 * live in one composition so the launch context is obvious before creation.
 */
export function WelcomeScreen() {
  const sessions = useSessionStore((state) => state.sessions)
  const noProjectWorkDir = useSessionStore((state) => state.noProjectWorkDir)
  const startSessionWithMessage = useSessionStore((state) => state.startSessionWithMessage)
  const projects = useMemo(
    () => collectProjects(sessions, noProjectWorkDir),
    [noProjectWorkDir, sessions],
  )

  const [chosenTarget, setChosenTarget] = useState<NewSessionTarget | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const [attachments, setAttachments] = useState<UserAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const attachmentsRef = useRef<UserAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const target: NewSessionTarget =
    chosenTarget ??
    (projects[0]
      ? { kind: 'project', workDir: projects[0].workDir }
      : { kind: 'no-project' })
  const targetLabel =
    target.kind === 'no-project' ? NO_PROJECT_LABEL : projectDisplayName(target.workDir)
  const targetTitle = target.kind === 'no-project' ? NO_PROJECT_LABEL : target.workDir

  const autoGrow = (): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }

  const handlePickFolder = async (): Promise<void> => {
    const workDir = await window.lmcodeAPI.selectWorkDirectory()
    if (workDir) setChosenTarget({ kind: 'project', workDir })
  }

  const attachPastedFile = async (file: File): Promise<void> => {
    if (attachmentsRef.current.length >= MAX_PROMPT_ATTACHMENTS) {
      setAttachmentError(`每条消息最多附加 ${MAX_PROMPT_ATTACHMENTS} 个文件`)
      return
    }
    setAttachmentError(null)
    try {
      const filePath = window.lmcodeAPI.getPathForFile(file) || undefined
      let preview: FileAttachmentPreview
      if (filePath) {
        if (attachmentsRef.current.some((item) => item.filePath === filePath)) return
        preview = await window.lmcodeAPI.readFileAttachment(filePath)
      } else {
        if (!file.type.startsWith('image/')) return
        const dataUrl = await fileToDataUrl(file)
        preview = await window.lmcodeAPI.readInlineImageAttachment(
          file.name || defaultPastedImageName(file.type),
          dataUrl,
        )
      }
      const attachment: UserAttachment = {
        id: `attachment_${globalThis.crypto.randomUUID()}`,
        kind: preview.kind,
        name: preview.name,
        filePath,
        sizeBytes: preview.sizeBytes,
        truncated: preview.kind === 'text' ? preview.truncated : false,
        previewUrl: preview.kind === 'image' ? preview.dataUrl : undefined,
      }
      const current = attachmentsRef.current
      const isDuplicate = filePath
        ? current.some((item) => item.filePath === filePath)
        : preview.kind === 'image' &&
          current.some((item) => item.previewUrl === attachment.previewUrl)
      if (isDuplicate || current.length >= MAX_PROMPT_ATTACHMENTS) return
      const next = [...current, attachment]
      attachmentsRef.current = next
      setAttachments(next)
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : `无法附加“${file.name || '剪贴板文件'}”`,
      )
    }
  }

  const removeAttachment = (id: string): void => {
    const next = attachmentsRef.current.filter((attachment) => attachment.id !== id)
    attachmentsRef.current = next
    setAttachments(next)
    setAttachmentError(null)
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    let files = Array.from(event.clipboardData.files)
    if (files.length === 0) {
      // Some clipboard sources expose image data only through items.
      files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
    }
    if (files.length === 0) return
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    void (async () => {
      for (const file of files.slice(0, MAX_PROMPT_ATTACHMENTS)) {
        await attachPastedFile(file)
      }
    })()
  }

  const handleSubmit = (): void => {
    const text = draft.trim()
    const pendingAttachments = attachmentsRef.current
    if ((!text && pendingAttachments.length === 0) || starting) return
    setStarting(true)
    attachmentsRef.current = []
    setAttachments([])
    setAttachmentError(null)
    void startSessionWithMessage(target, text, pendingAttachments).finally(() => setStarting(false))
  }

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[720px]">
        <AgentWelcome />

        <div className="rounded-[18px] border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] shadow-[var(--lm-shadow-soft)] transition-[border-color,box-shadow] focus-within:border-[var(--lm-text-muted)] focus-within:shadow-[var(--lm-shadow-composer)]">
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
            onPaste={handlePaste}
            placeholder="描述你想交给 Agent 完成的任务…"
            rows={2}
            className="block max-h-[220px] min-h-[78px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed text-[var(--lm-text-primary)] placeholder:text-[var(--lm-text-muted)]"
          />

          {attachments.length > 0 && (
            <div className="px-3 pb-1">
              <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
            </div>
          )}

          <div className="flex items-center gap-1 border-t border-transparent px-2.5 pb-2.5 pt-1">
            <DropdownMenu.Root open={pickerOpen} onOpenChange={setPickerOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  title={targetTitle}
                  aria-label={`任务位置：${targetTitle}`}
                  className="flex max-w-[190px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[var(--lm-text-secondary)] outline-none transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]"
                >
                  {target.kind === 'no-project' ? (
                    <FolderX size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
                  ) : (
                    <Folder size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
                  )}
                  <span className="min-w-0 truncate">{targetLabel}</span>
                  <ChevronDown
                    size={12}
                    className={cn('shrink-0 text-[var(--lm-text-muted)] transition-transform', pickerOpen && 'rotate-180')}
                  />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  className="z-50 w-80 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-pop)]"
                >
                  <DropdownMenu.Label className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--lm-text-muted)]">
                    任务位置
                  </DropdownMenu.Label>
                  <div className="max-h-60 overflow-y-auto">
                    {projects.length === 0 && (
                      <p className="px-2.5 py-3 text-[12px] text-[var(--lm-text-muted)]">
                        暂无最近项目
                      </p>
                    )}
                    {projects.map((project) => {
                      const selected =
                        target.kind === 'project' && project.workDir === target.workDir
                      return (
                        <DropdownMenu.Item
                          key={project.workDir}
                          onSelect={() => setChosenTarget({ kind: 'project', workDir: project.workDir })}
                          title={project.workDir}
                          className={cn(targetMenuItemClass, selected && 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]')}
                        >
                          <Folder size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-medium">{projectDisplayName(project.workDir)}</span>
                            <span className="truncate text-[10px] text-[var(--lm-text-muted)]">
                              {truncateProjectPath(project.workDir, 42)}
                            </span>
                          </span>
                          <span className="shrink-0 text-[10px] text-[var(--lm-text-muted)]">
                            {project.sessionCount}
                          </span>
                          {selected && <Check size={13} className="shrink-0 text-[var(--lm-accent-text)]" />}
                        </DropdownMenu.Item>
                      )
                    })}
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-[var(--lm-border)]" />
                  <DropdownMenu.Item
                    onSelect={() => void handlePickFolder()}
                    className={targetMenuItemClass}
                  >
                    <FolderOpen size={14} />
                    选择文件夹…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => setChosenTarget({ kind: 'no-project' })}
                    className={cn(
                      targetMenuItemClass,
                      target.kind === 'no-project' && 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]',
                    )}
                  >
                    <FolderX size={14} />
                    <span className="flex-1">{NO_PROJECT_LABEL}</span>
                    {target.kind === 'no-project' && (
                      <Check size={13} className="text-[var(--lm-accent-text)]" />
                    )}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <ModelSwitcher />
            <ThinkingSwitcher />
            <div className="flex-1" />
            <span className="hidden text-[10px] text-[var(--lm-text-muted)] sm:inline">
              Enter 发送 · Shift+Enter 换行
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={(!draft.trim() && attachments.length === 0) || starting}
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--lm-accent)] text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:opacity-30"
              title={starting ? '正在创建任务…' : '开始任务'}
              aria-label="开始任务"
            >
              <ArrowUp size={16} strokeWidth={2.3} />
            </button>
          </div>
        </div>

        {attachmentError && (
          <p className="mt-2 text-center text-[12px] text-[var(--lm-error)]">
            {attachmentError}
          </p>
        )}

        <p className="mt-3 text-center text-[11px] text-[var(--lm-text-muted)]">
          Agent 默认只在所选工作区内操作，需要额外权限时会向你确认。
        </p>
      </div>
    </main>
  )
}
