import { useRef, useCallback, useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  FileUp,
  Paperclip,
  Square,
  X,
} from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { useSession } from '@/hooks/useSession'
import { ModelSwitcher } from '@/components/ModelSwitcher'
import { ThinkingSwitcher } from '@/components/ThinkingSwitcher'
import { ProjectPicker } from '@/components/ProjectPicker'
import { AttachmentStrip } from '@/components/AttachmentStrip'
import { UsageFooter } from '@/components/UsageFooter'
import { SlashCommandsDialog, SLASH_COMMANDS, type SlashCommand } from '@/components/SlashCommandsDialog'
import { historyToMessages } from '@/lib/history'
import {
  buildDesktopReviewPrompt,
  filterSlashCommands,
  parseDesktopSlashCommand,
  shouldHandleSlashKeys,
} from '@/lib/slash-command'
import type { GoalSnapshotData } from '@lmcode-cli/lmcode-sdk'
import { MAX_PROMPT_ATTACHMENTS, type FileAttachmentPreview } from '../../shared/file-types'
import type { QueuedUserMessage, UserAttachment } from '@/types'
import type { CommandPaletteRequest, ComposerDraftRequest } from '@/lib/menu-command'
import { mergeComposerDraft } from '@/lib/composer-draft'
import {
  clearComposerDraft,
  getComposerDraft,
  saveComposerDraft,
} from '@/lib/composer-drafts'
import { defaultPastedImageName } from '@/lib/pasted-image-name'
import { fileToDataUrl } from '@/lib/file-to-data-url'

interface ComposerProps {
  autoFocus?: boolean
  onOpenSettings?: () => void
  onOpenGitReview?: () => void
  commandPaletteRequest?: CommandPaletteRequest | null
  composerDraftRequest?: ComposerDraftRequest | null
  onCommandPaletteRequestConsumed?: (nonce: number) => void
  onComposerDraftRequestConsumed?: (nonce: number) => void
}

interface ElectronFile extends File {
  readonly path?: string
}

const COMMAND_HELP = [
  '**可用命令**',
  '- `/goal <目标>`：创建目标并开始执行；支持 `status`、`pause`、`resume`、`replace`。',
  '- `/goaloff`：取消当前目标。',
  '- `/plan` / `/plan off`：进入或退出规划模式。',
  '- `/compact [说明]`：压缩当前上下文。',
  '- `/revoke [轮数]`：撤销最近的用户轮次。',
  '- `/review`：打开代码审查；支持 `uncommitted`、`base <分支>`、`commit <引用>`、`custom <重点>`。',
  '- `/model`：打开模型选择器。',
  '- `/mode`、`/config`：打开设置。',
  '- `/clear`：在当前项目中新建对话。',
  '- `/export`：导出当前会话。',
  '- `/dream`：整理记忆库（合并重复、清理过期条目）。',
].join('\n')

const EMPTY_QUEUED_MESSAGES: readonly QueuedUserMessage[] = []

function goalStatusText(goal: GoalSnapshotData | null): string {
  if (!goal) return '🎯 当前没有目标。使用 `/goal <目标>` 创建。'
  const remaining = goal.budget.remainingTokens
  const budget = remaining === null ? '' : ` · 剩余 ${remaining.toLocaleString()} tokens`
  return `🎯 **${goal.objective}**\n\n状态：${goal.status} · 已执行 ${goal.turnsUsed} 轮${budget}`
}

export function Composer({
  autoFocus,
  onOpenSettings,
  onOpenGitReview,
  commandPaletteRequest,
  composerDraftRequest,
  onCommandPaletteRequestConsumed,
  onComposerDraftRequestConsumed,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const streamStatus = useSessionStore((s) => s.streamStatus)
  const addMessageToSession = useSessionStore((s) => s.addMessageToSession)
  const setMessagesForSession = useSessionStore((s) => s.setMessagesForSession)
  const queuedMessages = useSessionStore((s) =>
    currentSessionId ? s.messageQueue[currentSessionId] ?? EMPTY_QUEUED_MESSAGES : EMPTY_QUEUED_MESSAGES,
  )
  const updateQueuedMessage = useSessionStore((s) => s.updateQueuedMessage)
  const removeQueuedMessage = useSessionStore((s) => s.removeQueuedMessage)
  const moveQueuedMessage = useSessionStore((s) => s.moveQueuedMessage)
  const {
    sendMessage,
    steerMessage,
    queueMessage,
    cancel,
    createSession,
    isStreaming,
  } = useSession()

  const [showSlash, setShowSlash] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [attachments, setAttachments] = useState<UserAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [attachmentLoadCount, setAttachmentLoadCount] = useState(0)
  const attachmentsRef = useRef<UserAttachment[]>([])
  const attachmentGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const dragCounter = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if ((autoFocus || currentSessionId) && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [currentSessionId, autoFocus])

  useEffect(() => {
    attachmentGenerationRef.current += 1
    attachmentsRef.current = []
    setAttachments([])
    setAttachmentError(null)
    setAttachmentLoadCount(0)
    setIsDragging(false)
    dragCounter.current = 0
  }, [currentSessionId])

  const autoGrow = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }, [])

  // Restore the per-session text draft. The textarea is uncontrolled and
  // ChatPanel remounts the composer keyed by session id, so without this the
  // unsent text would be silently discarded on every session switch.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta || !currentSessionId) return
    const draft = getComposerDraft(currentSessionId)
    ta.value = draft
    setHasDraft(Boolean(draft.trim()))
    autoGrow()
  }, [currentSessionId, autoGrow])

  // Save the draft for the outgoing session before switching away or
  // unmounting; the cleanup runs before the restore effect above re-runs.
  useEffect(() => {
    return () => {
      if (currentSessionId) {
        saveComposerDraft(currentSessionId, textareaRef.current?.value ?? '')
      }
    }
  }, [currentSessionId])

  useEffect(() => {
    if (!commandPaletteRequest) return
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.value = '/'
    textarea.setSelectionRange(1, 1)
    setHasDraft(true)
    setSlashQuery('')
    setShowSlash(true)
    setModelMenuOpen(false)
    autoGrow()
    textarea.focus()
    onCommandPaletteRequestConsumed?.(commandPaletteRequest.nonce)
  }, [autoGrow, commandPaletteRequest, onCommandPaletteRequestConsumed])

  useEffect(() => {
    if (!composerDraftRequest) return
    const textarea = textareaRef.current
    if (!textarea) return
    const next = mergeComposerDraft(textarea.value, composerDraftRequest)
    textarea.value = next
    textarea.setSelectionRange(next.length, next.length)
    setHasDraft(Boolean(next.trim()))
    setShowSlash(false)
    setSlashQuery('')
    setModelMenuOpen(false)
    autoGrow()
    textarea.focus()
    onComposerDraftRequestConsumed?.(composerDraftRequest.nonce)
  }, [autoGrow, composerDraftRequest, onComposerDraftRequestConsumed])

  // ── Attach a file (shared by drop + file picker) ───────────────────
  const removeAttachment = useCallback((id: string) => {
    const next = attachmentsRef.current.filter((attachment) => attachment.id !== id)
    attachmentsRef.current = next
    setAttachments(next)
    setAttachmentError(null)
  }, [])

  const attachFile = useCallback(
    async (file: File) => {
      const attachmentGeneration = attachmentGenerationRef.current
      const filePath = window.lmcodeAPI.getPathForFile(file) || (file as ElectronFile).path
      if (
        filePath &&
        attachmentsRef.current.some((attachment) => attachment.filePath === filePath)
      ) return
      if (attachmentsRef.current.length >= MAX_PROMPT_ATTACHMENTS) {
        setAttachmentError(`每条消息最多附加 ${MAX_PROMPT_ATTACHMENTS} 个文件`)
        return
      }

      setAttachmentError(null)
      setAttachmentLoadCount((count) => count + 1)
      try {
        let preview: FileAttachmentPreview
        if (filePath) {
          preview = await window.lmcodeAPI.readFileAttachment(filePath)
        } else {
          if (!file.type.startsWith('image/')) {
            throw new Error(`无法读取“${file.name || '剪贴板文件'}”的本地路径`)
          }
          const dataUrl = await fileToDataUrl(file)
          preview = await window.lmcodeAPI.readInlineImageAttachment(
            file.name || defaultPastedImageName(file.type),
            dataUrl,
          )
        }
        if (
          !mountedRef.current ||
          attachmentGeneration !== attachmentGenerationRef.current
        ) return
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
            current.some((item) => item.previewUrl === preview.dataUrl)
        if (isDuplicate || current.length >= MAX_PROMPT_ATTACHMENTS) return
        const next = [...current, attachment]
        attachmentsRef.current = next
        setAttachments(next)
      } catch (error) {
        if (
          !mountedRef.current ||
          attachmentGeneration !== attachmentGenerationRef.current
        ) return
        setAttachmentError(
          error instanceof Error ? error.message : `无法附加“${file.name}”`,
        )
      } finally {
        if (
          mountedRef.current &&
          attachmentGeneration === attachmentGenerationRef.current
        ) {
          setAttachmentLoadCount((count) => Math.max(0, count - 1))
        }
      }
    },
    [],
  )

  // ── Drag-and-drop ──────────────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      dragCounter.current = 0
      const files = Array.from(e.dataTransfer.files)
      for (const file of files.slice(0, MAX_PROMPT_ATTACHMENTS)) {
        await attachFile(file)
      }
    },
    [attachFile],
  )

  const handleFilePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      for (const file of files) await attachFile(file)
      e.target.value = ''
    },
    [attachFile],
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
          await attachFile(file)
        }
      })()
    },
    [attachFile],
  )

  // ── Slash commands ─────────────────────────────────────────────────
  const detectSlashCommand = useCallback(
    (value: string, cursorPos: number) => {
      if (cursorPos === 1 && value === '/') {
        setShowSlash(true)
        setSlashQuery('')
        return true
      }
      if (showSlash) {
        const slashIdx = value.indexOf('/')
        if (slashIdx === 0 && !value.includes(' ')) {
          setSlashQuery(value.slice(1))
          return true
        }
        if (slashIdx !== 0 || value.includes(' ')) {
          setShowSlash(false)
          setSlashQuery('')
        }
      }
      return false
    },
    [showSlash],
  )

  const showNotice = useCallback(
    (content: string, variant: 'notice' | 'error' = 'notice') => {
      if (!currentSessionId) return
      addMessageToSession(currentSessionId, {
        id: `notice_${globalThis.crypto.randomUUID()}`,
        role: 'system',
        content,
        variant,
        timestamp: Date.now(),
      })
    },
    [addMessageToSession, currentSessionId],
  )

  const executeSlashCommand = useCallback(
    async (input: string): Promise<boolean> => {
      const command = parseDesktopSlashCommand(input)
      if (command === null) return false
      if (!currentSessionId) return true

      try {
        switch (command.kind) {
          case 'error':
            showNotice(command.message, 'error')
            break
          case 'goal-status': {
            const result = await window.lmcodeAPI.getGoal(currentSessionId)
            showNotice(goalStatusText(result.goal))
            break
          }
          case 'goal-create':
            await window.lmcodeAPI.createGoal(
              currentSessionId,
              command.objective,
              command.replace,
            )
            showNotice(`🎯 目标已设置：${command.objective}`)
            await sendMessage(command.objective)
            break
          case 'goal-pause': {
            const result = await window.lmcodeAPI.getGoal(currentSessionId)
            if (!result.goal) {
              showNotice('🎯 当前没有可暂停的目标。')
              break
            }
            await window.lmcodeAPI.updateGoalStatus(currentSessionId, 'paused')
            showNotice('🎯 目标已暂停。使用 `/goal resume` 恢复。')
            break
          }
          case 'goal-resume': {
            const result = await window.lmcodeAPI.getGoal(currentSessionId)
            if (!result.goal) {
              showNotice('🎯 当前没有可恢复的目标。')
              break
            }
            await window.lmcodeAPI.updateGoalStatus(currentSessionId, 'active')
            showNotice('🎯 目标已恢复。')
            await sendMessage('继续执行当前目标。')
            break
          }
          case 'goal-cancel': {
            const result = await window.lmcodeAPI.getGoal(currentSessionId)
            if (!result.goal) {
              showNotice('🎯 当前没有目标。')
              break
            }
            await window.lmcodeAPI.cancelGoal(currentSessionId)
            showNotice('🎯 目标已取消。')
            break
          }
          case 'plan':
            await window.lmcodeAPI.setPlanMode(currentSessionId, command.enabled)
            showNotice(command.enabled ? '规划模式已开启。' : '规划模式已关闭。')
            break
          case 'compact':
            showNotice('正在压缩当前会话上下文…')
            await window.lmcodeAPI.compactSession(currentSessionId, command.instruction)
            showNotice('上下文压缩完成。')
            break
          case 'revoke': {
            await window.lmcodeAPI.undoHistory(currentSessionId, command.count)
            const history = await window.lmcodeAPI.getSessionHistory(currentSessionId)
            setMessagesForSession(currentSessionId, historyToMessages(history))
            showNotice(`已撤销最近 ${command.count} 轮对话。`)
            break
          }
          case 'review-open':
            onOpenGitReview?.()
            break
          case 'review-run':
            await sendMessage(buildDesktopReviewPrompt(command))
            break
          case 'model':
            setModelMenuOpen(true)
            break
          case 'mode':
          case 'config':
            onOpenSettings?.()
            break
          case 'clear': {
            const state = useSessionStore.getState()
            const workDir = state.sessions.find(
              (session) => session.id === currentSessionId,
            )?.workDir
            await createSession(workDir)
            break
          }
          case 'export': {
            const zipPath = await window.lmcodeAPI.exportSession(currentSessionId)
            showNotice(`会话已导出到：\n\n\`${zipPath}\``)
            break
          }
          case 'dream':
            await window.lmcodeAPI.activateSkill(currentSessionId, 'dream')
            showNotice('已开始整理记忆库，Agent 会在对话中给出整理方案。')
            break
          case 'help':
            showNotice(COMMAND_HELP)
            break
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        showNotice(`命令执行失败：${message}`, 'error')
      }
      return true
    },
    [
      createSession,
      currentSessionId,
      onOpenGitReview,
      onOpenSettings,
      sendMessage,
      setMessagesForSession,
      showNotice,
    ],
  )

  // ── Send / Cancel ──────────────────────────────────────────────────
  const handleSend = useCallback((delivery: 'default' | 'steer' = 'default') => {
    const ta = textareaRef.current
    if (!ta) return
    const text = ta.value
    const pendingAttachments = attachmentsRef.current
    if ((!text.trim() && pendingAttachments.length === 0) || attachmentLoadCount > 0) return
    if (text.trim().startsWith('/') && pendingAttachments.length > 0) {
      setAttachmentError('斜杠命令不能携带附件，请先移除附件或发送普通消息')
      return
    }
    ta.value = ''
    ta.style.height = 'auto'
    setHasDraft(false)
    setShowSlash(false)
    setSlashQuery('')
    setAttachmentError(null)
    attachmentsRef.current = []
    setAttachments([])
    if (currentSessionId) clearComposerDraft(currentSessionId)
    if (text.trim().startsWith('/')) {
      void executeSlashCommand(text)
    } else if (isStreaming && delivery === 'steer') {
      void steerMessage(text, pendingAttachments)
    } else if (isStreaming) {
      queueMessage(text, pendingAttachments)
    } else {
      void sendMessage(text, pendingAttachments)
    }
  }, [
    attachmentLoadCount,
    currentSessionId,
    executeSlashCommand,
    isStreaming,
    queueMessage,
    sendMessage,
    steerMessage,
  ])

  // Match count the slash dialog will show; with zero matches the dialog
  // renders nothing, so the composer must not swallow navigation keys.
  const slashMatchCount = showSlash
    ? filterSlashCommands(SLASH_COMMANDS, slashQuery).length
    : 0

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlash) {
        if (shouldHandleSlashKeys(showSlash, slashMatchCount)) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
            e.preventDefault()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            return
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowSlash(false)
          setSlashQuery('')
          return
        }
        if (e.key === 'Backspace') {
          const ta = e.currentTarget
          if (ta.selectionStart === 1 && ta.value === '/') {
            setShowSlash(false)
            setSlashQuery('')
          }
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend(isStreaming && (e.ctrlKey || e.metaKey) ? 'steer' : 'default')
      }
    },
    [handleSend, isStreaming, showSlash, slashMatchCount],
  )

  const handleInput = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    setHasDraft(Boolean(ta.value.trim()))
    autoGrow()
    detectSlashCommand(ta.value, ta.selectionStart)
  }, [autoGrow, detectSlashCommand])

  const handleSlashSelect = useCallback((command: SlashCommand) => {
    const ta = textareaRef.current
    if (!ta) return
    setShowSlash(false)
    setSlashQuery('')
    ta.value = command.insertText ?? ''
    setHasDraft(Boolean(command.insertText?.trim()))
    if (command.insertText) {
      ta.setSelectionRange(command.insertText.length, command.insertText.length)
      autoGrow()
    } else {
      ta.style.height = 'auto'
      void executeSlashCommand(command.label)
    }
    ta.focus()
  }, [autoGrow, executeSlashCommand])

  const handleSlashClose = useCallback(() => {
    setShowSlash(false)
    setSlashQuery('')
    textareaRef.current?.focus()
  }, [])

  const canSend = hasDraft || attachments.length > 0
  const isAttaching = attachmentLoadCount > 0

  if (!currentSessionId) return null

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-[var(--lm-accent-text)]">
            <FileUp size={32} strokeWidth={1.5} />
            <span className="text-sm font-medium">释放文件以添加附件</span>
          </div>
        </div>
      )}

      {/* Slash dialog */}
      {showSlash && (
        <SlashCommandsDialog
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={handleSlashClose}
        />
      )}

      {queuedMessages.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-soft)]">
          <div className="flex items-center gap-1.5 border-b border-[var(--lm-border)] px-3 py-1.5 text-[11px] font-medium text-[var(--lm-text-muted)]">
            <ArrowDown size={11} />
            待发送队列 · {queuedMessages.length}
            <span className="ml-auto font-normal">回合结束后自动发送</span>
          </div>
          <div className="max-h-32 overflow-y-auto">
            {queuedMessages.map((message, index) => (
              <div
                key={message.id}
                className="flex items-center gap-1 border-b border-[var(--lm-border)] px-2 py-1.5 last:border-b-0"
              >
                <span className="w-5 shrink-0 text-center font-mono text-[10px] text-[var(--lm-text-muted)]">
                  {index + 1}
                </span>
                <input
                  value={message.text}
                  placeholder={message.attachments.length > 0 ? '仅发送附件' : undefined}
                  onChange={(event) => {
                    if (currentSessionId) {
                      updateQueuedMessage(currentSessionId, message.id, event.target.value)
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--lm-text-secondary)]"
                  aria-label={`编辑队列消息 ${index + 1}`}
                />
                {message.attachments.length > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[10px] text-[var(--lm-text-muted)]"
                    title={message.attachments.map((attachment) => attachment.name).join('、')}
                  >
                    <Paperclip size={9} />
                    {message.attachments.length}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => currentSessionId && moveQueuedMessage(currentSessionId, message.id, -1)}
                  disabled={index === 0}
                  className="rounded p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-25"
                  title="上移"
                  aria-label={`上移队列消息 ${index + 1}`}
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => currentSessionId && moveQueuedMessage(currentSessionId, message.id, 1)}
                  disabled={index === queuedMessages.length - 1}
                  className="rounded p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-25"
                  title="下移"
                  aria-label={`下移队列消息 ${index + 1}`}
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => currentSessionId && removeQueuedMessage(currentSessionId, message.id)}
                  className="rounded p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)]"
                  title="移除"
                  aria-label={`移除队列消息 ${index + 1}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-[18px] border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] shadow-[var(--lm-shadow-soft)] transition-[border-color,box-shadow] focus-within:border-[var(--lm-text-muted)] focus-within:shadow-[var(--lm-shadow-composer)]">
        {attachments.length > 0 && (
          <div className="px-3 pt-3">
            <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
          </div>
        )}
        {(attachmentError || isAttaching) && (
          <div
            className={`px-4 pt-2 text-[11px] ${
              attachmentError ? 'text-[var(--lm-error)]' : 'text-[var(--lm-text-muted)]'
            }`}
            role={attachmentError ? 'alert' : 'status'}
          >
            {attachmentError ?? '正在读取附件…'}
          </div>
        )}
        <textarea
          ref={textareaRef}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            isStreaming
              ? '继续输入…（Enter 排队，Ctrl+Enter 立即转向）'
              : '给 LMCODE 发消息…（可粘贴截图，/ 查看命令）'
          }
          rows={1}
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-relaxed text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none"
        />

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isAttaching || attachments.length >= MAX_PROMPT_ATTACHMENTS}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)]"
            title="附加文本文件或图片"
            aria-label="附加文本文件或图片"
          >
            <Paperclip size={17} />
          </button>

          <ProjectPicker display="name" />
          <ModelSwitcher open={modelMenuOpen} onOpenChange={setModelMenuOpen} />
          <ThinkingSwitcher />

          {streamStatus && (
            <span className="lm-pulse ml-1 truncate text-[12px] text-[var(--lm-text-muted)]">
              {streamStatus}
            </span>
          )}

          <div className="flex-1" />

          {isStreaming ? (
            <div className="flex items-center gap-1.5">
              <span className="hidden text-[10px] text-[var(--lm-text-muted)] sm:inline">
                Ctrl+Enter 转向
              </span>
              <button
                type="button"
                onClick={() => handleSend()}
                disabled={!canSend || isAttaching}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-accent)] text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:opacity-30"
                title="加入待发送队列"
                aria-label="加入待发送队列"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
              <button
                type="button"
                onClick={cancel}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-bg-active)] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-error)] hover:text-white"
                title="停止"
                aria-label="停止生成"
              >
                <Square size={14} fill="currentColor" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleSend()}
              disabled={!canSend || isAttaching}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-accent)] text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
              title="发送"
              aria-label="发送消息"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <UsageFooter />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilePick}
      />
    </div>
  )
}
