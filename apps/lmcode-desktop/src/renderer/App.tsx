import { useEffect, useCallback, useState } from 'react'
import { useSessionStore } from '@/stores/session-store'
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
import { applyTheme, getStoredTheme, type ThemePref } from '@/lib/theme'
import { historyToMessages } from '@/lib/history'
import type { SessionInfo } from '@/types'

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
    loadConfig()
  }, [loadConfig])

  // Re-hydrate a session's conversation from disk whenever it becomes active
  // (selecting it, or after an app restart) so messages don't vanish.
  useEffect(() => {
    if (!currentSessionId) return
    let cancelled = false
    ;(async () => {
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

  // Load sessions on mount
  useEffect(() => {
    ;(async () => {
      try {
        const rawSessions = await window.lmcodeAPI.listSessions()
        const mapped: SessionInfo[] = rawSessions.map((s) => ({
          id: s.id,
          title: s.title,
          workDir: s.workDir,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          thinkingLevel: 'auto',
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
        } else {
          await createSession()
        }
      } catch (err) {
        console.error('Failed to load sessions:', err)
        await createSession()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleOpenSettings = useCallback(() => {
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowSettings(true)
  }, [])

  const handleOpenMemory = useCallback(() => {
    setShowSettings(false)
    setShowTasks(false)
    setShowExtensions(false)
    setShowMemory(true)
  }, [])

  const handleOpenExtensions = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowTasks(false)
    setShowExtensions(true)
  }, [])

  const handleToggleTasks = useCallback(() => {
    setShowSettings(false)
    setShowMemory(false)
    setShowExtensions(false)
    setShowTasks((prev) => !prev)
  }, [])

  // Menu / tray navigation (新建对话, 设置 from the native menu and tray).
  useEffect(() => {
    const unsub = window.lmcodeAPI.onNavigate(({ route }) => {
      if (route === 'new-session') {
        void createSession()
      } else if (route === 'settings') {
        handleOpenSettings()
      }
    })
    return unsub
  }, [createSession, handleOpenSettings])

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
          onOpenSettings={handleOpenSettings}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />

        {currentSessionId ? (
          <ChatPanel />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[var(--lm-text-muted)]">
            <p>请选择或创建一个会话</p>
          </div>
        )}
      </div>

      {/* Overlays */}
      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        theme={theme}
        onThemeChange={setTheme}
      />
      <MemoryBrowser open={showMemory} onClose={() => setShowMemory(false)} />
      <TasksPanel open={showTasks} onClose={() => setShowTasks(false)} />
      <ExtensionsPanel open={showExtensions} onClose={() => setShowExtensions(false)} />

      {/* Dialogs */}
      <ApprovalDialog />
      <QuestionDialog />
    </div>
  )
}
