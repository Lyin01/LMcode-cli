import { useEffect, useCallback, useState } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useSubagentStore } from '@/stores/subagent-store'
import { useConfigStore } from '@/stores/config-store'
import { useEvents } from '@/hooks/useEvents'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { ChatPanel } from '@/components/ChatPanel'
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
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { applyTheme, getStoredTheme, type ThemePref } from '@/lib/theme'
import { historyToMessages } from '@/lib/history'
import type { SessionInfo } from '@/types'
import { FolderOpen } from 'lucide-react'
import { isThinkingEffort } from '@/lib/thinking'

export default function App() {
  const loadConfig = useConfigStore((s) => s.loadConfig)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setSessions = useSessionStore((s) => s.setSessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const createSession = useSessionStore((s) => s.createSession)

  const [showSettings, setShowSettings] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showExtensions, setShowExtensions] = useState(false)
  const [showGitReview, setShowGitReview] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showWorktrees, setShowWorktrees] = useState(false)
  const [showSubagents, setShowSubagents] = useState(false)
  const [showAutomations, setShowAutomations] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme, setThemeState] = useState<ThemePref>(() => getStoredTheme())

  useEvents()

  // Apply stored theme once on mount (index.html already set the attribute,
  // this keeps React state and the document in sync).
  useEffect(() => {
    applyTheme(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setTheme = useCallback((next: ThemePref) => {
    setThemeState(next)
    applyTheme(next)
  }, [])

  // Load config on mount
  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  // Re-hydrate a session's conversation from disk whenever it becomes active
  // (selecting it, or after an app restart) so messages don't vanish.
  useEffect(() => {
    if (!currentSessionId) return
    let cancelled = false
    void (async () => {
      try {
        const raw = await window.lmcodeAPI.getSessionHistory(currentSessionId)
        if (cancelled) return
        const st = useSessionStore.getState()
        // Only apply if we're still on this session and not mid-stream, and the
        // UI hasn't already accumulated live messages for it.
        if (
          st.currentSessionId === currentSessionId &&
          !st.isStreaming &&
          st.messages.length === 0
        ) {
          const mapped = historyToMessages(raw as unknown[])
          if (mapped.length > 0) st.setMessages(mapped)
        }
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
          useSessionStore.getState().updateSessionStatus({
            model: status.model,
            thinkingLevel,
            permission: status.permission,
            contextTokens: status.contextTokens,
            maxContextTokens: status.maxContextTokens,
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

        if (mapped.length > 0) {
          // Open the most recently used session on launch.
          const latest = [...mapped].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!
          selectSession(latest.id)
        }
      } catch (err) {
        console.error('Failed to load sessions:', err)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleOpenSettings = useCallback(() => {
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowSettings(true)
  }, [])

  const handleOpenMemory = useCallback(() => {
    setShowSettings(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowMemory(true)
  }, [])

  const handleOpenExtensions = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowExtensions(true)
  }, [])

  const handleToggleTasks = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowTasks((prev) => !prev)
  }, [])

  const handleOpenGitReview = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowGitReview(true)
  }, [])

  const handleOpenTerminal = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowTerminal(true)
  }, [])

  const handleOpenWorktrees = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowSubagents(false)
    setShowAutomations(false)
    setShowWorktrees(true)
  }, [])

  const handleOpenSubagents = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowAutomations(false)
    setShowSubagents(true)
  }, [])

  const handleOpenAutomations = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowGitReview(false)
    setShowTerminal(false)
    setShowWorktrees(false)
    setShowSubagents(false)
    setShowAutomations(true)
  }, [])

  // Menu / tray navigation (新建对话, 设置 from the native menu and tray).
  useEffect(() => {
    const unsub = window.lmcodeAPI.onNavigate(({ route }) => {
      if (route === 'new-session') {
        const state = useSessionStore.getState()
        const currentWorkDir = state.sessions.find(
          (session) => session.id === state.currentSessionId,
        )?.workDir
        void createSession(currentWorkDir)
      } else if (route === 'settings') {
        handleOpenSettings()
      } else if (route === 'automations') {
        handleOpenAutomations()
      }
    })
    return unsub
  }, [createSession, handleOpenAutomations, handleOpenSettings])

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--lm-bg-base)] text-[var(--lm-text-primary)]">
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        onOpenSettings={handleOpenSettings}
        onOpenMemory={handleOpenMemory}
        onOpenExtensions={handleOpenExtensions}
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
            <ChatPanel onOpenSettings={handleOpenSettings} />
          </ErrorBoundary>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="flex max-w-md flex-col items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--lm-accent-soft)] text-[var(--lm-accent-text)]">
                <FolderOpen size={28} strokeWidth={1.6} />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-[var(--lm-text-primary)]">
                  打开一个项目开始工作
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--lm-text-muted)]">
                  LMCODE 会把会话、工具权限和文件操作限定到你选择的工作目录。
                </p>
              </div>
              <button
                onClick={() => void createSession()}
                className="flex items-center gap-2 rounded-lg bg-[var(--lm-accent)] px-4 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] shadow-[var(--lm-shadow-soft)] transition-colors hover:bg-[var(--lm-accent-hover)]"
              >
                <FolderOpen size={16} />
                选择项目文件夹
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Overlays */}
      <ErrorBoundary name="设置">
        <SettingsPanel
          open={showSettings}
          onClose={() => setShowSettings(false)}
          theme={theme}
          onThemeChange={setTheme}
        />
      </ErrorBoundary>
      <ErrorBoundary name="记忆库">
        <MemoryBrowser open={showMemory} onClose={() => setShowMemory(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="任务">
        <TasksPanel open={showTasks} onClose={() => setShowTasks(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="扩展">
        <ExtensionsPanel open={showExtensions} onClose={() => setShowExtensions(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="Git 审查">
        <GitReviewPanel open={showGitReview} onClose={() => setShowGitReview(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="终端">
        <TerminalPanel open={showTerminal} onClose={() => setShowTerminal(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="Worktrees">
        <WorktreesPanel open={showWorktrees} onClose={() => setShowWorktrees(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="子代理">
        <SubagentsPanel open={showSubagents} onClose={() => setShowSubagents(false)} />
      </ErrorBoundary>
      <ErrorBoundary name="自动化">
        <AutomationsPanel open={showAutomations} onClose={() => setShowAutomations(false)} />
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
