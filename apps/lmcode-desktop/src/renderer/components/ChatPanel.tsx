import { useSessionStore } from '@/stores/session-store'
import { MessageList } from '@/components/MessageList'
import { Composer } from '@/components/Composer'
import { RunActivity } from '@/components/RunActivity'
import { AgentWelcome } from '@/components/AgentWelcome'
import type {
  CommandPaletteRequest,
  ComposerDraftRequest,
  ConversationFindRequest,
} from '@/lib/menu-command'

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
        <div className="w-full max-w-[720px] pb-10">
          <AgentWelcome />
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
          <RunActivity />
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
