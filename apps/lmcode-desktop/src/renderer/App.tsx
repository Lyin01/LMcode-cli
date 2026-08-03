import { useEffect, useCallback, useRef, useState } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { useConfigStore } from '@/stores/config-store'
import { useEvents } from '@/hooks/useEvents'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { ChatPanel } from '@/components/ChatPanel'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { ApprovalDialog } from '@/components/dialogs/ApprovalDialog'
import { QuestionDialog } from '@/components/dialogs/QuestionDialog'
import { SettingsPanel } from '@/components/SettingsPanel'
import { MemoryBrowser } from '@/components/MemoryBrowser'
import { TasksPanel } from '@/components/TasksPanel'
import { ExtensionsPanel } from '@/components/ExtensionsPanel'
import { GitReviewPanel } from '@/components/GitReviewPanel'
import { TerminalPanel } from '@/components/TerminalPanel'
import { WorktreesPanel } from '@/components/WorktreesPanel'
import { SubagentsPanel } from '@/components/SubagentsPanel'
import { AutomationsPanel } from '@/components/AutomationsPanel'
import { KeyboardShortcutsPanel } from '@/components/KeyboardShortcutsPanel'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { applyTheme, getStoredTheme, type ThemePref } from '@/lib/theme'
import { historyToMessages } from '@/lib/history'
import { isNoProjectWorkDir } from '@/lib/projects'
import type { SessionInfo } from '@/types'
import { isThinkingEffort } from '@/lib/thinking'
import { registerPermissionModeShortcut } from '@/lib/permission-shortcut'
import { getStoredSidebarOpen, setStoredSidebarOpen } from '@/lib/sidebar-preference'
import {
  getAdjacentConversationIds,
  type CommandPaletteRequest,
  type ComposerDraftRequest,
  type ConversationFindRequest,
  type RenameConversationRequest,
} from '@/lib/menu-command'
import type { DesktopMenuCommand } from '../shared/menu-types'
import { nextPermissionMode } from '../shared/permission-mode'

function appendMenuNotice(sessionId: string, content: string, isError = false): void {
  useSessionStore.getState().addMessageToSession(sessionId, {
    id: `menu_notice_${globalThis.crypto.randomUUID()}`,
    role: 'system',
    content,
    variant: isError ? 'error' : 'notice',
    timestamp: Date.now(),
  })
}

type ActivePanel =
  | 'settings'
  | 'memory'
  | 'tasks'
  | 'extensions'
  | 'git-review'
  | 'terminal'
  | 'worktrees'
  | 'subagents'
  | 'automations'
  | 'keyboard-shortcuts'

export default function App() {
  const loadConfig = useConfigStore((s) => s.loadConfig)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const messageCount = useSessionStore((s) => s.messages.length)
  const setSessions = useSessionStore((s) => s.setSessions)
  const createSession = useSessionStore((s) => s.createSession)

  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => getStoredSidebarOpen())
  const [theme, setThemeState] = useState<ThemePref>(() => getStoredTheme())
  const [searchRequestNonce, setSearchRequestNonce] = useState(0)
  const [renameRequest, setRenameRequest] = useState<RenameConversationRequest | null>(null)
  const [findRequest, setFindRequest] = useState<ConversationFindRequest | null>(null)
  const [commandPaletteRequest, setCommandPaletteRequest] =
    useState<CommandPaletteRequest | null>(null)
  const [composerDraftRequest, setComposerDraftRequest] =
    useState<ComposerDraftRequest | null>(null)
  const menuRequestNonceRef = useRef(0)
  const permissionSwitchingRef = useRef(false)

  useEvents()

  // Apply stored theme once on mount (index.html already set the attribute,
  // this keeps React state and the document in sync).
  useEffect(() => {
    applyTheme(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setStoredSidebarOpen(sidebarOpen)
  }, [sidebarOpen])

  // Shift+Tab is an application shortcut, so listen once at the window capture
  // phase instead of relying on whichever control currently owns focus.
  useEffect(() => {
    return registerPermissionModeShortcut(window, () => {
      if (permissionSwitchingRef.current) return
      permissionSwitchingRef.current = true

      const state = useSessionStore.getState()
      const sessionId = state.currentSessionId
      void state.setPermissionPreference(nextPermissionMode(state.permissionPreference))
        .catch((error: unknown) => {
          if (sessionId === null) return
          const message = error instanceof Error ? error.message : String(error)
          appendMenuNotice(sessionId, `权限模式切换失败：${message}`, true)
        })
        .finally(() => {
          permissionSwitchingRef.current = false
        })
    })
  }, [])

  const setTheme = useCallback((next: ThemePref) => {
    setThemeState(next)
    applyTheme(next)
  }, [])

  const nextMenuRequestNonce = useCallback((): number => {
    menuRequestNonceRef.current += 1
    return menuRequestNonceRef.current
  }, [])

  const handleCommandPaletteRequestConsumed = useCallback((nonce: number) => {
    setCommandPaletteRequest((current) => current?.nonce === nonce ? null : current)
  }, [])

  const handleComposerDraftRequestConsumed = useCallback((nonce: number) => {
    setComposerDraftRequest((current) => current?.nonce === nonce ? null : current)
  }, [])

  const handleAddReviewCommentsToChat = useCallback((text: string) => {
    setComposerDraftRequest({
      nonce: nextMenuRequestNonce(),
      text,
      mode: 'append',
    })
  }, [nextMenuRequestNonce])

  useEffect(() => {
    const adjacent = getAdjacentConversationIds(sessions, currentSessionId)
    window.lmcodeAPI.updateMenuState({
      hasActiveSession: currentSessionId !== null,
      canFindInConversation: currentSessionId !== null && messageCount > 0,
      sidebarOpen,
      canGoPrevious: adjacent.previousId !== null,
      canGoNext: adjacent.nextId !== null,
    })
  }, [currentSessionId, messageCount, sessions, sidebarOpen])

  // Load config on mount
  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  // Resolve the no-project sentinel directory once so the UI can recognize
  // sessions that are not tied to a project.
  useEffect(() => {
    void window.lmcodeAPI.getNoProjectWorkDir()
      .then((workDir) => {
        if (typeof workDir === 'string' && workDir.trim()) {
          useSessionStore.getState().setNoProjectWorkDir(workDir)
        }
      })
      .catch(() => {})
  }, [])

  // Re-hydrate a session's conversation from disk whenever it becomes active
  // (selecting it, or after an app restart) so messages don't vanish.
  useEffect(() => {
    if (!currentSessionId) return
    let cancelled = false
    void (async () => {
      try {
        // The store tracks which sessions were already hydrated — a slow
        // fetch must not be dropped just because the user typed (or a live
        // event landed) while it was in flight, and must never run twice.
        if (useSessionStore.getState().hydratedSessions[currentSessionId]) return
        const raw = await window.lmcodeAPI.getSessionHistory(currentSessionId)
        if (cancelled) return
        const mapped = historyToMessages(raw as unknown[])
        useSessionStore.getState().hydrateSessionHistory(currentSessionId, mapped)
      } catch (err) {
        console.error('Failed to load session history:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentSessionId])

  useEffect(() => {
    if (!currentSessionId) return
    let cancelled = false
    void window.lmcodeAPI.getSessionStatus(currentSessionId)
      .then((status) => {
        if (!cancelled && useSessionStore.getState().currentSessionId === currentSessionId) {
          const thinkingLevel = isThinkingEffort(status.thinkingLevel)
            ? status.thinkingLevel
            : useSessionStore.getState().thinkingLevel
          const state = useSessionStore.getState()
          state.updateSessionStatus({
            model: status.model,
            thinkingLevel,
            permission: status.permission,
            contextTokens: status.contextTokens,
            maxContextTokens: status.maxContextTokens,
          })
          void state.applyPermissionPreference(currentSessionId).catch((error: unknown) => {
            if (cancelled) return
            const message = error instanceof Error ? error.message : String(error)
            appendMenuNotice(currentSessionId, `无法应用全局权限模式：${message}`, true)
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [currentSessionId])

  // Rehydrate persisted background work when switching sessions. Live events
  // continue updating the same stores after this snapshot is applied.
  useEffect(() => {
    if (!currentSessionId) return
    let cancelled = false
    void window.lmcodeAPI.listBackgroundTasks(currentSessionId)
      .then((tasks) => {
        if (cancelled) return
        const taskStore = useTaskStore.getState()
        for (const task of tasks) taskStore.addOrUpdateTask(currentSessionId, task)
        useSubagentStore.getState().hydrateTasks(currentSessionId, tasks)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [currentSessionId])

  // Load sessions on mount
  useEffect(() => {
    void (async () => {
      try {
        const rawSessions = await window.lmcodeAPI.listSessions()
        const thinkingLevel = useSessionStore.getState().thinkingLevel
        const mapped: SessionInfo[] = rawSessions.map((s) => ({
          id: s.id,
          title: s.title,
          workDir: s.workDir,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          thinkingLevel,
          permission: 'manual',
          contextTokens: 0,
          maxContextTokens: 128000,
          isStreaming: false,
        }))
        setSessions(mapped)

        // Deliberately do NOT auto-resume the most recent session: launch
        // lands on the welcome screen, and the sidebar remains the way to
        // pick a previous conversation.
      } catch (err) {
        console.error('Failed to load sessions:', err)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleOpenSettings = useCallback(() => {
    setActivePanel('settings')
  }, [])

  const handleOpenMemory = useCallback(() => {
    setActivePanel('memory')
  }, [])

  const handleOpenExtensions = useCallback(() => {
    setActivePanel('extensions')
  }, [])

  const handleOpenKeyboardShortcuts = useCallback(() => {
    setActivePanel('keyboard-shortcuts')
  }, [])

  const handleToggleTasks = useCallback(() => {
    setActivePanel((current) => current === 'tasks' ? null : 'tasks')
  }, [])

  const handleOpenGitReview = useCallback(() => {
    // No-project sessions live in the sentinel workspace, which is not a git
    // repository — the review/worktree surfaces stay closed for them.
    const store = useSessionStore.getState()
    const current = store.sessions.find((s) => s.id === store.currentSessionId)
    if (isNoProjectWorkDir(current?.workDir, store.noProjectWorkDir)) return
    setActivePanel('git-review')
  }, [])

  const handleOpenTerminal = useCallback(() => {
    setActivePanel('terminal')
  }, [])

  const handleOpenWorktrees = useCallback(() => {
    const store = useSessionStore.getState()
    const current = store.sessions.find((s) => s.id === store.currentSessionId)
    if (isNoProjectWorkDir(current?.workDir, store.noProjectWorkDir)) return
    setActivePanel('worktrees')
  }, [])

  const handleOpenSubagents = useCallback(() => {
    setActivePanel('subagents')
  }, [])

  const handleOpenAutomations = useCallback(() => {
    setActivePanel('automations')
  }, [])

  const handleMenuCommand = useCallback(
    (command: DesktopMenuCommand): void => {
      const state = useSessionStore.getState()
      switch (command) {
        case 'new-conversation': {
          // Land on the welcome screen; the session is created when the first
          // message is submitted there.
          state.clearCurrentSession()
          setActivePanel(null)
          break
        }
        case 'open-project':
          setActivePanel(null)
          void createSession()
          break
        case 'rename-conversation':
          if (state.currentSessionId !== null) {
            setSidebarOpen(true)
            setRenameRequest({
              sessionId: state.currentSessionId,
              nonce: nextMenuRequestNonce(),
            })
          }
          break
        case 'export-conversation':
          if (state.currentSessionId !== null) {
            const sessionId = state.currentSessionId
            void window.lmcodeAPI.exportSession(sessionId).then(
              (zipPath) => appendMenuNotice(sessionId, `会话已导出到：\n\n\`${zipPath}\``),
              (error: unknown) =>
                appendMenuNotice(
                  sessionId,
                  `导出会话失败：${error instanceof Error ? error.message : String(error)}`,
                  true,
                ),
            )
          }
          break
        case 'show-settings':
          handleOpenSettings()
          break
        case 'find-in-conversation':
          setFindRequest({ action: 'open', nonce: nextMenuRequestNonce() })
          break
        case 'find-next':
          setFindRequest({ action: 'next', nonce: nextMenuRequestNonce() })
          break
        case 'find-previous':
          setFindRequest({ action: 'previous', nonce: nextMenuRequestNonce() })
          break
        case 'search-conversations':
          setSidebarOpen(true)
          setSearchRequestNonce(nextMenuRequestNonce())
          break
        case 'show-command-palette':
          setCommandPaletteRequest({ nonce: nextMenuRequestNonce() })
          break
        case 'toggle-sidebar':
          setSidebarOpen((open) => !open)
          break
        case 'show-git-review':
          handleOpenGitReview()
          break
        case 'show-terminal':
          handleOpenTerminal()
          break
        case 'show-worktrees':
          handleOpenWorktrees()
          break
        case 'show-subagents':
          handleOpenSubagents()
          break
        case 'show-tasks':
          handleToggleTasks()
          break
        case 'show-automations':
          handleOpenAutomations()
          break
        case 'show-extensions':
          handleOpenExtensions()
          break
        case 'show-memory':
          handleOpenMemory()
          break
        case 'previous-conversation':
        case 'next-conversation': {
          const adjacent = getAdjacentConversationIds(state.sessions, state.currentSessionId)
          const targetId =
            command === 'previous-conversation' ? adjacent.previousId : adjacent.nextId
          if (targetId !== null) state.selectSession(targetId)
          break
        }
        case 'toggle-theme':
          setTheme(theme === 'dark' ? 'light' : 'dark')
          break
        case 'show-keyboard-shortcuts':
          setActivePanel('keyboard-shortcuts')
          break
        default: {
          const unreachable: never = command
          return unreachable
        }
      }
    },
    [
      createSession,
      handleOpenAutomations,
      handleOpenExtensions,
      handleOpenGitReview,
      handleOpenMemory,
      handleOpenSettings,
      handleOpenSubagents,
      handleOpenTerminal,
      handleOpenWorktrees,
      handleToggleTasks,
      nextMenuRequestNonce,
      setTheme,
      theme,
    ],
  )

  useEffect(
    () => window.lmcodeAPI.onMenuCommand(({ command }) => handleMenuCommand(command)),
    [handleMenuCommand],
  )

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--lm-bg-base)] text-[var(--lm-text-primary)]">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        onOpenSettings={handleOpenSettings}
        onOpenMemory={handleOpenMemory}
        onOpenExtensions={handleOpenExtensions}
        searchRequestNonce={searchRequestNonce}
        renameRequest={renameRequest}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onOpenTasks={handleToggleTasks}
          onOpenGitReview={handleOpenGitReview}
          onOpenTerminal={handleOpenTerminal}
          onOpenWorktrees={handleOpenWorktrees}
          onOpenSubagents={handleOpenSubagents}
          onOpenAutomations={handleOpenAutomations}
          onOpenSettings={handleOpenSettings}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />

        {currentSessionId ? (
          <ErrorBoundary name="对话">
            <ChatPanel
              onOpenSettings={handleOpenSettings}
              onOpenGitReview={handleOpenGitReview}
              findRequest={findRequest}
              commandPaletteRequest={commandPaletteRequest}
              composerDraftRequest={composerDraftRequest}
              onCommandPaletteRequestConsumed={handleCommandPaletteRequestConsumed}
              onComposerDraftRequestConsumed={handleComposerDraftRequestConsumed}
            />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary name="欢迎">
            <WelcomeScreen />
          </ErrorBoundary>
        )}
      </div>

      {/* Overlays */}
      <ErrorBoundary name="设置">
        <SettingsPanel
          open={activePanel === 'settings'}
          onClose={() => setActivePanel(null)}
          onOpenExtensions={handleOpenExtensions}
          onOpenKeyboardShortcuts={handleOpenKeyboardShortcuts}
          theme={theme}
          onThemeChange={setTheme}
        />
      </ErrorBoundary>
      <ErrorBoundary name="记忆库">
        <MemoryBrowser open={activePanel === 'memory'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="任务">
        <TasksPanel open={activePanel === 'tasks'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="扩展">
        <ExtensionsPanel open={activePanel === 'extensions'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="Git 审查">
        <GitReviewPanel
          open={activePanel === 'git-review'}
          onClose={() => setActivePanel(null)}
          onAddCommentsToChat={handleAddReviewCommentsToChat}
        />
      </ErrorBoundary>
      <ErrorBoundary name="终端">
        <TerminalPanel open={activePanel === 'terminal'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="Worktrees">
        <WorktreesPanel open={activePanel === 'worktrees'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="子代理">
        <SubagentsPanel open={activePanel === 'subagents'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="自动化">
        <AutomationsPanel open={activePanel === 'automations'} onClose={() => setActivePanel(null)} />
      </ErrorBoundary>
      <ErrorBoundary name="键盘快捷键">
        <KeyboardShortcutsPanel
          open={activePanel === 'keyboard-shortcuts'}
          onClose={() => setActivePanel(null)}
        />
      </ErrorBoundary>

      {/* Dialogs */}
      <ErrorBoundary name="审批对话框">
        <ApprovalDialog />
      </ErrorBoundary>
      <ErrorBoundary name="提问对话框">
        <QuestionDialog />
      </ErrorBoundary>
    </div>
  )
}
