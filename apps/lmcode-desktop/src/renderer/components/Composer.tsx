import { useRef, useCallback, useEffect, useState } from 'react'
import { ArrowUp, Square, Paperclip, FileUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useSession } from '@/hooks/useSession'
import { ModelSwitcher } from '@/components/ModelSwitcher'
import { ThinkingSwitcher } from '@/components/ThinkingSwitcher'
import { SlashCommandsDialog, type SlashCommand } from '@/components/SlashCommandsDialog'

interface ComposerProps {
  autoFocus?: boolean
}

export function Composer({ autoFocus }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const streamStatus = useSessionStore((s) => s.streamStatus)
  const { sendMessage, cancel, isStreaming } = useSession()

  const [showSlash, setShowSlash] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [isDragging, setIsDragging] = useState(false)
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
      const filePath = (file as any).path as string | undefined
      if (!filePath) {
        insertAtCursor(`[拖入文件: ${file.name}]`)
        return
      }
      try {
        const content = await window.lmcodeAPI.readFileContent(filePath)
        insertAtCursor(`[文件: ${file.name}]\n\`\`\`\n${content}\n\`\`\`\n`)
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

  // ── Send / Cancel ──────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    const text = ta.value
    if (!text.trim() || isStreaming) return
    ta.value = ''
    ta.style.height = 'auto'
    setShowSlash(false)
    setSlashQuery('')
    sendMessage(text)
  }, [sendMessage, isStreaming])

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
        handleSend()
      }
    },
    [handleSend, showSlash],
  )

  const handleInput = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    autoGrow()
    detectSlashCommand(ta.value, ta.selectionStart)
  }, [autoGrow, detectSlashCommand])

  const handleSlashSelect = useCallback((command: SlashCommand) => {
    const ta = textareaRef.current
    if (!ta) return
    setShowSlash(false)
    setSlashQuery('')
    command.action()
    ta.value = ''
    ta.style.height = 'auto'
    ta.focus()
  }, [])

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

      <div className="rounded-[20px] border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] shadow-[var(--lm-shadow-soft)] transition-colors focus-within:border-[var(--lm-accent)]">
        <textarea
          ref={textareaRef}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="给 LMCODE 发消息…  (Enter 发送，Shift+Enter 换行，/ 查看命令)"
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

          <ModelSwitcher />
          <ThinkingSwitcher />

          {streamStatus && (
            <span className="lm-pulse ml-1 truncate text-[11px] text-[var(--lm-text-muted)]">
              {streamStatus}
            </span>
          )}

          <div className="flex-1" />

          {isStreaming ? (
            <button
              onClick={cancel}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--lm-bg-active)] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-error)] hover:text-white"
              title="停止"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
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
