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
import { SlashCommandsDialog, type SlashCommand } from '@/components/SlashCommandsDialog'
import { historyToMessages } from '@/lib/history'
import { parseDesktopSlashCommand } from '@/lib/slash-command'
import type { GoalSnapshotData } from '@lmcode-cli/lmcode-sdk'
import type { QueuedUserMessage } from '@/types'

interface ComposerProps {
  autoFocus?: boolean
  onOpenSettings?: () => void
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
  '- `/model`：打开模型选择器。',
  '- `/mode`、`/config`：打开设置。',
  '- `/clear`：在当前项目中新建对话。',
  '- `/export`：导出当前会话。',
].join('\n')

const EMPTY_QUEUED_MESSAGES: readonly QueuedUserMessage[] = []

function goalStatusText(goal: GoalSnapshotData | null): string {
  if (!goal) return '🎯 当前没有目标。使用 `/goal <目标>` 创建。'
  const remaining = goal.budget.remainingTokens
  const budget = remaining === null ? '' : ` · 剩余 ${remaining.toLocaleString()} tokens`
  return `🎯 **${goal.objective}**\n\n状态：${goal.status} · 已执行 ${goal.turnsUsed} 轮${budget}`
}

export function Composer({ autoFocus, onOpenSettings }: ComposerProps) {
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
  const dragCounter = useRef(0)

  useEffect(() => {
    if ((autoFocus || currentSessionId) && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [currentSessionId, autoFocus])

  const autoGrow = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }, [])

  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    ta.setRangeText(text, start, start, 'end')
    autoGrow()
    ta.focus()
  }, [autoGrow])

  // ── Attach a file (shared by drop + file picker) ───────────────────
  const attachFile = useCallback(
    async (file: File) => {
      const filePath = window.lmcodeAPI.getPathForFile(file) || (file as ElectronFile).path
      if (!filePath) {
        insertAtCursor(`[拖入文件: ${file.name}]`)
        return
      }
      try {
        const attachment = await window.lmcodeAPI.readFileContent(filePath)
        const suffix = attachment.truncated
          ? `，已截断至 ${Math.round(attachment.content.length / 1024)} KB`
          : ''
        insertAtCursor(`[文件: ${file.name}${suffix}]\n\`\`\`\n${attachment.content}\n\`\`\`\n`)
      } catch {
        insertAtCursor(`[文件: ${file.name} (读取失败)]`)
      }
    },
    [insertAtCursor],
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
      if (files[0]) await attachFile(files[0])
    },
    [attachFile],
  )

  const handleFilePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) await attachFile(file)
      e.target.value = ''
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
    if (!text.trim()) return
    ta.value = ''
    ta.style.height = 'auto'
    setHasDraft(false)
    setShowSlash(false)
    setSlashQuery('')
    if (text.trim().startsWith('/')) {
      void executeSlashCommand(text)
    } else if (isStreaming && delivery === 'steer') {
      void steerMessage(text)
    } else if (isStreaming) {
      queueMessage(text)
    } else {
      void sendMessage(text)
    }
  }, [executeSlashCommand, isStreaming, queueMessage, sendMessage, steerMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlash) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
          e.preventDefault()
          return
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          return
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
    [handleSend, isStreaming, showSlash],
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
            <span className="text-sm font-medium">释放文件以添加到消息</span>
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
          <div className="flex items-center gap-1.5 border-b border-[var(--lm-border)] px-3 py-1.5 text-[10px] font-medium text-[var(--lm-text-muted)]">
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
                <span className="w-5 shrink-0 text-center font-mono text-[9px] text-[var(--lm-text-muted)]">
                  {index + 1}
                </span>
                <input
                  value={message.text}
                  onChange={(event) => {
                    if (currentSessionId) {
                      updateQueuedMessage(currentSessionId, message.id, event.target.value)
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--lm-text-secondary)]"
                  aria-label={`编辑队列消息 ${index + 1}`}
                />
                <button
                  onClick={() => currentSessionId && moveQueuedMessage(currentSessionId, message.id, -1)}
                  disabled={index === 0}
                  className="rounded p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-25"
                  title="上移"
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  onClick={() => currentSessionId && moveQueuedMessage(currentSessionId, message.id, 1)}
                  disabled={index === queuedMessages.length - 1}
                  className="rounded p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-25"
                  title="下移"
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  onClick={() => currentSessionId && removeQueuedMessage(currentSessionId, message.id)}
                  className="rounded p-1 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)]"
                  title="移除"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-[20px] border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] shadow-[var(--lm-shadow-soft)] transition-colors focus-within:border-[var(--lm-accent)]">
        <textarea
          ref={textareaRef}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming
              ? '继续输入…（Enter 排队，Ctrl+Enter 立即转向）'
              : '给 LMCODE 发消息…  (Enter 发送，Shift+Enter 换行，/ 查看命令)'
          }
          rows={1}
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-relaxed text-[var(--lm-text-primary)] placeholder-[var(--lm-text-muted)] outline-none"
        />

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)]"
            title="附加文件"
          >
            <Paperclip size={17} />
          </button>

          <ModelSwitcher open={modelMenuOpen} onOpenChange={setModelMenuOpen} />
          <ThinkingSwitcher />

          {streamStatus && (
            <span className="lm-pulse ml-1 truncate text-[11px] text-[var(--lm-text-muted)]">
              {streamStatus}
            </span>
          )}

          <div className="flex-1" />

          {isStreaming ? (
            <div className="flex items-center gap-1.5">
              <span className="hidden text-[9px] text-[var(--lm-text-muted)] sm:inline">
                Ctrl+Enter 转向
              </span>
              <button
                onClick={() => handleSend()}
                disabled={!hasDraft}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-accent)] text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:opacity-30"
                title="加入待发送队列"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
              <button
                onClick={cancel}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-bg-active)] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-error)] hover:text-white"
                title="停止"
              >
                <Square size={14} fill="currentColor" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleSend()}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-accent)] text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:opacity-40"
              title="发送"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFilePick}
      />
    </div>
  )
}
