import { useSessionStore } from '@/stores/session-store'
import { MessageList } from '@/components/MessageList'
import { Composer } from '@/components/Composer'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export function ChatPanel() {
  const messages = useSessionStore((s) => s.messages)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)

  if (!currentSessionId) return null

  if (messages.length === 0) {
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
          <Composer autoFocus />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <MessageList />
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto max-w-3xl">
          <Composer />
        </div>
      </div>
    </div>
  )
}
