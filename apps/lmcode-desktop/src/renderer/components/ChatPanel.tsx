import { useSessionStore } from '@/stores/session-store'
import { MessageList } from '@/components/MessageList'
import { Composer } from '@/components/Composer'
import { ProjectPicker } from '@/components/ProjectPicker'
import { StallIndicator } from '@/components/StallIndicator'
import type {
  CommandPaletteRequest,
  ComposerDraftRequest,
  ConversationFindRequest,
} from '@/lib/menu-command'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

interface ChatPanelProps {
  onOpenSettings?: () => void
  onOpenGitReview?: () => void
  findRequest: ConversationFindRequest | null
  commandPaletteRequest: CommandPaletteRequest | null
  composerDraftRequest: ComposerDraftRequest | null
  onCommandPaletteRequestConsumed: (nonce: number) => void
  onComposerDraftRequestConsumed: (nonce: number) => void
}

export function ChatPanel({
  onOpenSettings,
  onOpenGitReview,
  findRequest,
  commandPaletteRequest,
  composerDraftRequest,
  onCommandPaletteRequestConsumed,
  onComposerDraftRequestConsumed,
}: ChatPanelProps) {
  // Narrow boolean selector: subscribing to the whole `messages` array would
  // re-render this panel (and the heavy Composer subtree) on every stream delta.
  const isEmpty = useSessionStore((s) => s.messages.length === 0)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)

  if (!currentSessionId) return null

  if (isEmpty) {
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
          <div className="mb-2 flex">
            <ProjectPicker display="name" />
          </div>
          <StallIndicator />
          <Composer
            key={currentSessionId}
            autoFocus
            onOpenSettings={onOpenSettings}
            onOpenGitReview={onOpenGitReview}
            commandPaletteRequest={commandPaletteRequest}
            composerDraftRequest={composerDraftRequest}
            onCommandPaletteRequestConsumed={onCommandPaletteRequestConsumed}
            onComposerDraftRequestConsumed={onComposerDraftRequestConsumed}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <MessageList findRequest={findRequest} />
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto max-w-3xl">
          <div className="mb-1.5 flex">
            <ProjectPicker display="name" />
          </div>
          <StallIndicator />
          <Composer
            key={currentSessionId}
            onOpenSettings={onOpenSettings}
            onOpenGitReview={onOpenGitReview}
            commandPaletteRequest={commandPaletteRequest}
            composerDraftRequest={composerDraftRequest}
            onCommandPaletteRequestConsumed={onCommandPaletteRequestConsumed}
            onComposerDraftRequestConsumed={onComposerDraftRequestConsumed}
          />
        </div>
      </div>
    </div>
  )
}
