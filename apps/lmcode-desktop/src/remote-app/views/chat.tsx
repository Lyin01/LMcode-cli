import { useEffect, useRef, useState } from 'react'
import type { ConnectionPhase } from '../client'
import type { TranscriptItem } from '../transcript'

export interface ChatViewProps {
  readonly title: string
  readonly phase: ConnectionPhase
  readonly running: boolean
  readonly loading: boolean
  readonly items: readonly TranscriptItem[]
  readonly onBack: () => void
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
}

export function ChatView({
  title,
  phase,
  running,
  loading,
  items,
  onBack,
  onSend,
  onCancel,
}: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Follow new output while the reader stays near the bottom; leave their
  // scroll position alone once they scroll back through history.
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140
    if (nearBottom) element.scrollTop = element.scrollHeight
  }, [items, running])

  const online = phase === 'online'
  const canSend = online && draft.trim().length > 0

  return (
    <div className="rm-chat">
      <header className="rm-header">
        <button className="rm-ghost" type="button" onClick={onBack} aria-label="返回会话列表">
          ‹ 返回
        </button>
        <div className="rm-header-copy rm-header-center">
          <div className="rm-header-title">{title}</div>
          <div className="rm-header-sub">
            {phase === 'online' ? (running ? '运行中' : '空闲') : phase === 'connecting' ? '连接中…' : '已断开'}
          </div>
        </div>
        {running ? (
          <button className="rm-danger" type="button" onClick={onCancel} disabled={!online}>
            停止
          </button>
        ) : (
          <span className="rm-header-spacer" />
        )}
      </header>

      <div className="rm-chat-body" ref={scrollRef}>
        {loading && <div className="rm-muted rm-center">正在载入对话…</div>}
        {!loading && items.length === 0 && (
          <div className="rm-muted rm-center">在下面输入第一条消息，开始远程对话。</div>
        )}
        {items.map((item) => (
          <TranscriptRow key={item.id} item={item} />
        ))}
      </div>

      <form
        className="rm-composer"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          onSend(draft)
          setDraft('')
        }}
      >
        <textarea
          className="rm-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={online ? (running ? '输入转向内容，运行中的任务会读到它' : '输入消息') : '等待重新连接…'}
          rows={2}
          enterKeyHint="send"
          disabled={!online}
        />
        <button className="rm-primary rm-send" type="submit" disabled={!canSend}>
          {running ? '转向' : '发送'}
        </button>
      </form>
    </div>
  )
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="rm-msg rm-msg-user">{item.text}</div>
    case 'assistant':
      return (
        <div className="rm-msg rm-msg-assistant">
          {item.thinking.length > 0 && (
            <details className="rm-thinking">
              <summary>思考过程</summary>
              <pre>{item.thinking}</pre>
            </details>
          )}
          {item.text.length > 0 ? <div className="rm-msg-text">{item.text}</div> : null}
        </div>
      )
    case 'tool':
      return (
        <div className={`rm-tool rm-tool-${item.status}`}>
          <span className="rm-tool-name">{item.name}</span>
          <span className="rm-tool-status">
            {item.status === 'running' ? '运行中' : item.status === 'error' ? '失败' : '完成'}
          </span>
          {item.detail !== undefined && <div className="rm-tool-detail">{item.detail}</div>}
        </div>
      )
    case 'notice':
      return <div className={`rm-notice rm-notice-${item.level}`}>{item.text}</div>
  }
}
