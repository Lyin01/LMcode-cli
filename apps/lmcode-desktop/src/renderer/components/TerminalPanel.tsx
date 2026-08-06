import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Check,
  Copy,
  Eraser,
  Loader2,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createLatestRequestGate } from '@/lib/latest-request'
import { launchTerminal } from '@/lib/terminal-session'
import { AnsiStateParser, type AnsiSegment } from '@/lib/ansi'
import { useSessionStore } from '@/stores/session-store'
import type {
  ProjectTerminalInfo,
  TerminalOutputPayload,
  TerminalOutputStream,
} from '../../shared/terminal-types'

interface TerminalPanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

interface TerminalChunk {
  readonly id: number
  readonly stream: TerminalOutputStream
  /** 已固化的 ANSI 着色片段（颜色不依赖运行时状态）。 */
  readonly segments: readonly AnsiSegment[]
}

const TERMINAL_OUTPUT_LIMIT_CHARS = 250_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendChunk(chunks: readonly TerminalChunk[], next: TerminalChunk): TerminalChunk[] {
  const merged = [...chunks]
  const last = merged.at(-1)
  if (last?.stream === next.stream) {
    merged[merged.length - 1] = {
      ...last,
      segments: [...last.segments, ...next.segments],
    }
  } else {
    merged.push(next)
  }

  let total = merged.reduce((sum, chunk) => sum + chunkTextLength(chunk), 0)
  while (total > TERMINAL_OUTPUT_LIMIT_CHARS && merged.length > 1) {
    total -= chunkTextLength(merged.shift()!)
  }
  if (total > TERMINAL_OUTPUT_LIMIT_CHARS && merged[0]) {
    const head = merged[0]
    const kept: AnsiSegment[] = []
    let keptLength = 0
    for (let i = head.segments.length - 1; i >= 0; i--) {
      const segment = head.segments[i]!
      if (keptLength + segment.text.length >= TERMINAL_OUTPUT_LIMIT_CHARS) break
      kept.unshift(segment)
      keptLength += segment.text.length
    }
    merged[0] = { ...head, segments: kept }
  }
  return merged
}

function chunkTextLength(chunk: TerminalChunk): number {
  let total = 0
  for (const segment of chunk.segments) total += segment.text.length
  return total
}

async function copyTerminalText(chunks: readonly TerminalChunk[]): Promise<boolean> {
  // segments 已是剥离 ANSI 与危险控制字符后的纯文本。
  const plain = chunks.map((chunk) => chunk.segments.map((s) => s.text).join('')).join('')
  try {
    await navigator.clipboard.writeText(plain)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = plain
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

export function TerminalPanel({ open, onClose }: TerminalPanelProps) {
  const sessionId = useSessionStore((state) => state.currentSessionId)
  const [info, setInfo] = useState<ProjectTerminalInfo | null>(null)
  const [chunks, setChunks] = useState<TerminalChunk[]>([])
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [starting, setStarting] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextChunkId = useRef(1)
  const activeSession = useRef<string | null>(null)
  const autoStartSession = useRef<string | null>(null)
  // Latest-wins guard: a start() that resolves after the session switched
  // must not land its stale state (the launch helper also reclaims the shell).
  const startGateRef = useRef(createLatestRequestGate())
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // ANSI 状态跨 chunk 延续；会话切换时 reset。
  const ansiParserRef = useRef(new AnsiStateParser())
  // 复制按钮需要最新 chunks；state 异步更新不及时，用 ref 同步镜像。
  const chunksRef = useRef<TerminalChunk[]>([])
  const [followOutput, setFollowOutput] = useState(true)
  const [copied, setCopied] = useState(false)

  const pushOutput = useCallback((stream: TerminalOutputStream, text: string) => {
    const segments = ansiParserRef.current.push(text)
    if (segments.length === 0) return
    const chunk: TerminalChunk = { id: nextChunkId.current, stream, segments }
    nextChunkId.current += 1
    const next = appendChunk(chunksRef.current, chunk)
    chunksRef.current = next
    setChunks(next)
  }, [])

  const handleOutputScroll = useCallback(() => {
    const el = outputRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== followOutput) setFollowOutput(atBottom)
  }, [followOutput])

  const jumpToBottom = useCallback(() => {
    setFollowOutput(true)
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const handleCopy = useCallback(async () => {
    const ok = await copyTerminalText(chunksRef.current)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }, [])

  const start = useCallback(async () => {
    if (!sessionId) return
    const gate = startGateRef.current
    const ticket = gate.begin()
    setStarting(true)
    setError(null)
    try {
      const result = await launchTerminal(window.lmcodeAPI, gate, ticket, sessionId)
      if (!result.adopted) return
      setInfo(result.info)
      setRunning(result.info.running)
      activeSession.current = sessionId
    } catch (reason) {
      if (!gate.isCurrent(ticket)) return
      setRunning(false)
      setError(errorMessage(reason))
    } finally {
      if (gate.isCurrent(ticket)) setStarting(false)
    }
  }, [sessionId])

  useEffect(() => {
    return window.lmcodeAPI.onTerminalOutput((payload: TerminalOutputPayload) => {
      if (payload.sessionId !== activeSession.current) return
      pushOutput(payload.stream, payload.data)
      if (payload.stream === 'system' && payload.data.includes('[终端已退出')) {
        setRunning(false)
      }
    })
  }, [pushOutput])

  useEffect(() => {
    const prior = activeSession.current
    if (prior && prior !== sessionId) void window.lmcodeAPI.stopTerminal(prior)
    activeSession.current = sessionId
    autoStartSession.current = null
    // Invalidate any in-flight start for the previous session: its resolve
    // would otherwise overwrite this session's state and leak its shell.
    startGateRef.current.begin()
    setInfo(null)
    setChunks([])
    chunksRef.current = []
    setCommand('')
    setHistory([])
    setHistoryIndex(0)
    setRunning(false)
    setFollowOutput(true)
    ansiParserRef.current.reset()
  }, [sessionId])

  useEffect(() => {
    if (!open) {
      autoStartSession.current = null
      return
    }
    if (sessionId && autoStartSession.current !== sessionId) {
      autoStartSession.current = sessionId
      void start()
    }
  }, [open, sessionId, start])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    if (followOutput) outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight })
    inputRef.current?.focus()
  }, [chunks, followOutput, open])

  const sendCommand = async (): Promise<void> => {
    const input = command.trimEnd()
    if (!sessionId || !running || !input.trim()) return
    setCommand('')
    const nextHistory = [...history.filter((item) => item !== input), input]
    setHistory(nextHistory)
    setHistoryIndex(nextHistory.length)
    pushOutput('system', `> ${input}\n`)
    try {
      await window.lmcodeAPI.writeTerminal(sessionId, `${input}\n`)
    } catch (reason) {
      setError(errorMessage(reason))
      setRunning(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!sessionId) return
    setError(null)
    try {
      await window.lmcodeAPI.stopTerminal(sessionId)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRunning(false)
    }
  }

  const restart = async (): Promise<void> => {
    if (!sessionId) return
    await stop()
    await start()
  }

  if (!open) return null

  return (
    <section className="fixed bottom-0 right-0 z-40 flex h-[45vh] w-[min(1000px,calc(100vw-48px))] flex-col overflow-hidden rounded-tl-2xl border-l border-t border-[var(--lm-border)] bg-[var(--lm-bg-code)] shadow-[var(--lm-shadow-pop)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] px-3">
        <SquareTerminal size={15} className="text-[var(--lm-accent-text)]" />
        <span className="text-[12px] font-semibold text-[var(--lm-text-primary)]">项目终端</span>
        {info && (
          <span className="min-w-0 truncate font-mono text-[10px] text-[var(--lm-text-muted)]">
            {info.shell} · {info.workDir}
          </span>
        )}
        <span
          className={cn(
            'ml-auto h-2 w-2 rounded-full',
            running ? 'bg-[var(--lm-success)]' : 'bg-[var(--lm-text-muted)]',
          )}
          title={running ? '运行中' : '已停止'}
        />
        <button
          onClick={() => {
            setChunks([])
            chunksRef.current = []
            setFollowOutput(true)
          }}
          className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          title="清空显示"
        >
          <Eraser size={14} />
        </button>
        <button
          onClick={() => void handleCopy()}
          disabled={chunks.length === 0}
          className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
          title="复制全部输出"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          onClick={jumpToBottom}
          disabled={followOutput}
          className={cn(
            'rounded-md p-1.5 disabled:opacity-40',
            followOutput
              ? 'text-[var(--lm-text-muted)]'
              : 'text-[var(--lm-accent-text)] hover:bg-[var(--lm-bg-hover)]',
          )}
          title={followOutput ? '自动滚动已开启' : '自动滚动已暂停，点击恢复'}
        >
          <ArrowDownToLine size={14} />
        </button>
        <button
          onClick={() => void restart()}
          disabled={starting || !sessionId}
          className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:opacity-40"
          title="重启终端"
        >
          <RotateCcw size={14} className={starting ? 'lm-spin' : ''} />
        </button>
        <button
          onClick={() => void stop()}
          disabled={!running}
          className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)] disabled:opacity-40"
          title="停止终端"
        >
          <Square size={13} />
        </button>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-[var(--lm-text-muted)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          title="关闭"
        >
          <X size={15} />
        </button>
      </header>

      {error && (
        <div className="shrink-0 border-b border-[var(--lm-border)] bg-[var(--lm-accent-soft)] px-3 py-1.5 text-[11px] text-[var(--lm-error)]">
          {error}
        </div>
      )}

      <div
        ref={outputRef}
        onScroll={handleOutputScroll}
        className="min-h-0 flex-1 overflow-auto p-3"
      >
        {starting && chunks.length === 0 && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--lm-text-muted)]">
            <Loader2 size={13} className="lm-spin" /> 启动项目终端…
          </div>
        )}
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
          {chunks.map((chunk) => (
            <span
              key={chunk.id}
              className={cn(
                chunk.stream === 'stderr' && 'text-[var(--lm-error)]',
                chunk.stream === 'system' && 'text-[var(--lm-accent-text)]',
                chunk.stream === 'stdout' && 'text-[var(--lm-text-secondary)]',
              )}
            >
              {chunk.segments.map((segment, index) => (
                <span
                  key={index}
                  style={{
                    ...(segment.fg ? { color: segment.fg } : {}),
                    ...(segment.bg ? { backgroundColor: segment.bg } : {}),
                    ...(segment.bold ? { fontWeight: 700 } : {}),
                  }}
                >
                  {segment.text}
                </span>
              ))}
            </span>
          ))}
        </pre>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] px-3 py-2">
        <span className="font-mono text-[12px] text-[var(--lm-accent-text)]">›</span>
        <input
          ref={inputRef}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void sendCommand()
            } else if (event.key === 'ArrowUp' && history.length > 0) {
              event.preventDefault()
              const nextIndex = Math.max(0, historyIndex - 1)
              setHistoryIndex(nextIndex)
              setCommand(history[nextIndex] ?? '')
            } else if (event.key === 'ArrowDown' && history.length > 0) {
              event.preventDefault()
              const nextIndex = Math.min(history.length, historyIndex + 1)
              setHistoryIndex(nextIndex)
              setCommand(nextIndex === history.length ? '' : history[nextIndex] ?? '')
            }
          }}
          disabled={!running}
          placeholder={running ? '输入命令并按 Enter' : '终端已停止'}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--lm-text-primary)] placeholder:text-[var(--lm-text-muted)] disabled:cursor-not-allowed"
          spellCheck={false}
        />
        {!running && !starting && (
          <button
            onClick={() => void start()}
            disabled={!sessionId}
            className="flex items-center gap-1 rounded-md bg-[var(--lm-accent)] px-2 py-1 text-[10px] font-medium text-[var(--lm-accent-fg)] disabled:opacity-40"
          >
            <Play size={10} /> 启动
          </button>
        )}
      </div>
    </section>
  )
}
