import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  X,
  Sun,
  Moon,
  Monitor,
  Settings2,
  Cpu,
  Boxes,
  Brain,
  Wifi,
  Info,
  Check,
  Copy,
  Trash2,
  RefreshCw,
  Plus,
  Search,
  ExternalLink,
  Minimize2,
  Download,
  AlertTriangle,
  Keyboard,
  ArrowLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import type { ThemePref } from '@/lib/theme'
import { THINKING_OPTIONS, type ThinkingEffort } from '@/lib/thinking'
import type { PermissionMode } from '@lmcode-cli/lmcode-sdk'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  onOpenExtensions?: () => void
  onOpenKeyboardShortcuts?: () => void
  theme: ThemePref
  onThemeChange: (theme: ThemePref) => void
  initialSection?: SettingsTabId
}

export type SettingsTabId = 'general' | 'models' | 'plugins' | 'memory' | 'remote' | 'about'

interface SettingsNavTab {
  id: SettingsTabId
  label: string
  icon: typeof Settings2
  badge?: string
}

const SETTINGS_TABS: readonly SettingsNavTab[] = [
  { id: 'general', label: '通用设置', icon: Settings2 },
  { id: 'models', label: '模型与 API', icon: Cpu },
  { id: 'plugins', label: '扩展', icon: Boxes },
  { id: 'memory', label: '长期记忆库', icon: Brain },
  { id: 'remote', label: '局域网远程', icon: Wifi },
  { id: 'about', label: '关于', icon: Info },
]

const PERMISSION_MODES: readonly { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'manual', label: '手动审批', hint: '执行文件写入和危险命令前必须先经过人工确认。' },
  { value: 'auto', label: '自动允许', hint: '自动批准常规读写与安全命令，核心边界仍然拦截。' },
  { value: 'yolo', label: 'YOLO 模式', hint: '极速全自主执行，尽量减少打断，适合受控隔离环境。' },
]

const THEME_OPTIONS: readonly { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

export function SettingsPanel({
  open,
  onClose,
  onOpenExtensions,
  onOpenKeyboardShortcuts,
  theme,
  onThemeChange,
  initialSection = 'general',
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialSection)
  const [tabSearch, setTabSearch] = useState('')
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessionThinkingLevel = useSessionStore((s) => s.thinkingLevel)
  const sessionPermission = useSessionStore((s) => s.permission)
  const setThinkingPreference = useSessionStore((s) => s.setThinkingPreference)

  const [permission, setPermission] = useState<PermissionMode>('manual')
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Memory state
  const [memories, setMemories] = useState<Array<{ id: string; userNeed?: string; outcome?: string; tags?: string[] }>>([])
  const [memorySearch, setMemorySearch] = useState('')
  const [loadingMemories, setLoadingMemories] = useState(false)

  // MCP & Skills state
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; status: string }>>([])
  const [skills, setSkills] = useState<Array<{ name: string; description?: string }>>([])

  // Remote state
  const [remoteLanEnabled, setRemoteLanEnabled] = useState(false)
  const [remoteUrls, setRemoteUrls] = useState<string[]>([])

  // Maintenance state
  const [compacting, setCompacting] = useState(false)
  const [compactSuccess, setCompactSuccess] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialSection) setActiveTab(initialSection)
  }, [initialSection])

  useEffect(() => {
    if (sessionPermission) setPermission(sessionPermission as PermissionMode)
  }, [sessionPermission])

  useEffect(() => {
    if (!open) return
    void window.lmcodeAPI?.getVersion?.().then(setVersion).catch(() => {})
  }, [open])

  // Load section-specific data on tab switch
  useEffect(() => {
    if (!open) return
    if (activeTab === 'memory') {
      setLoadingMemories(true)
      void window.lmcodeAPI?.listMemories?.().then((res) => {
        setMemories((res as typeof memories) || [])
      }).catch(() => {}).finally(() => setLoadingMemories(false))
    } else if (activeTab === 'plugins' && currentSessionId) {
      void window.lmcodeAPI?.listMcpServers?.(currentSessionId).then((res) => {
        setMcpServers((res as typeof mcpServers) || [])
      }).catch(() => {})
      void window.lmcodeAPI?.listSkills?.(currentSessionId).then((res) => {
        setSkills((res as typeof skills) || [])
      }).catch(() => {})
    }
  }, [open, activeTab, currentSessionId])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const copyToClipboard = (text: string, key: string) => {
    void navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  const handleThinkingChange = async (value: ThinkingEffort) => {
    setSaving('thinkingLevel')
    try {
      await setThinkingPreference(value)
    } finally {
      setSaving(null)
    }
  }

  const handlePermissionChange = async (value: PermissionMode) => {
    setPermission(value)
    setSaving('permission')
    try {
      if (currentSessionId) {
        await window.lmcodeAPI?.setPermission(currentSessionId, value)
      }
    } finally {
      setSaving(null)
    }
  }

  const handleCompact = async () => {
    if (!currentSessionId || compacting) return
    setCompacting(true)
    try {
      await window.lmcodeAPI?.compactSession(currentSessionId)
      setCompactSuccess(true)
      setTimeout(() => setCompactSuccess(false), 2000)
    } finally {
      setCompacting(false)
    }
  }

  const handleExport = async () => {
    if (!currentSessionId) return
    try {
      await window.lmcodeAPI?.exportSession(currentSessionId)
      setExportSuccess(true)
      setTimeout(() => setExportSuccess(false), 2000)
    } catch (err) {
      console.error('Failed to export session:', err)
    }
  }

  const handleDeleteMemory = async (id: string) => {
    try {
      await window.lmcodeAPI?.deleteMemory(id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      console.error('Failed to delete memory:', err)
    }
  }

  const filteredMemories = useMemo(() => {
    if (!memorySearch.trim()) return memories
    const q = memorySearch.toLowerCase()
    return memories.filter(
      (m) =>
        m.userNeed?.toLowerCase().includes(q) ||
        m.outcome?.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q)),
    )
  }, [memories, memorySearch])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-md transition-opacity duration-200"
        onClick={onClose}
      />

      {/* DSH Modal Dialog Panel (860px x 640px) */}
      <div className="relative z-10 flex h-[640px] w-[900px] max-w-full overflow-hidden rounded-[24px] border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] shadow-[var(--lm-shadow-pop)] animate-scale-in">
        {/* Left Navigation Rail (DSH Style) */}
        <nav
          className="flex w-[210px] shrink-0 flex-col border-r border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)] p-3"
          aria-label="设置分类"
        >
          <div className="flex items-center justify-between px-2 py-2">
            <div>
              <h2 id="settings-title" className="text-[15px] font-semibold tracking-tight text-[var(--lm-text-primary)]">
                设置与选项
              </h2>
              <p className="text-[11px] text-[var(--lm-text-muted)]">LMCODE Enterprise</p>
            </div>
            <button
              onClick={onClose}
              className="flex items-center gap-1 text-[11px] text-[var(--lm-text-muted)] hover:text-[var(--lm-text-primary)] sm:hidden"
            >
              <ArrowLeft size={12} />
              <span>返回应用</span>
            </button>
          </div>

          {/* Quick Tab Search */}
          <div className="relative mt-2 px-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--lm-text-muted)] pointer-events-none" />
            <input
              type="search"
              value={tabSearch}
              onChange={(e) => setTabSearch(e.target.value)}
              placeholder="搜索设置..."
              aria-label="搜索设置"
              className="w-full rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-base)] py-1.5 pl-7 pr-2 text-[12px] text-[var(--lm-text-primary)] outline-none focus:border-[var(--lm-accent)]"
            />
          </div>

          <div className="mt-3 space-y-1">
            {SETTINGS_TABS.filter((t) => !tabSearch || t.label.toLowerCase().includes(tabSearch.toLowerCase())).map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-all duration-150',
                    isActive
                      ? 'bg-[var(--lm-accent-soft)] text-[var(--lm-accent-text)] shadow-xs'
                      : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]',
                  )}
                >
                  <Icon size={16} className={cn(isActive ? 'text-[var(--lm-accent-text)]' : 'text-[var(--lm-text-muted)]')} />
                  <span className="truncate">{tab.label}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-auto space-y-2 border-t border-[var(--lm-border)] px-1 pt-3">
            {onOpenKeyboardShortcuts && (
              <button
                onClick={() => {
                  onClose()
                  onOpenKeyboardShortcuts()
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
              >
                <Keyboard size={14} className="text-[var(--lm-text-muted)]" />
                <span>键盘快捷键</span>
              </button>
            )}

            <div className="flex items-center justify-between px-2 text-[11px] text-[var(--lm-text-muted)]">
              <span>桌面版本</span>
              <span className="font-mono">{version || 'v0.6.13'}</span>
            </div>
          </div>
        </nav>

        {/* Right Content View Area */}
        <div className="flex flex-1 min-w-0 flex-col bg-[var(--lm-bg-surface)]">
          {/* Header */}
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--lm-border)] px-6">
            <div className="flex items-center gap-3">
              <h3 className="text-[15px] font-semibold text-[var(--lm-text-primary)]">
                {SETTINGS_TABS.find((t) => t.id === activeTab)?.label}
              </h3>
              {currentSessionId && (
                <span className="flex items-center gap-1.5 rounded-full bg-[var(--lm-success)]/10 px-2 py-0.5 text-[10.5px] font-medium text-[var(--lm-success)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--lm-success)]" />
                  已连接
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
              >
                <ArrowLeft size={13} />
                <span>返回应用</span>
              </button>
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
                title="关闭设置 (Esc)"
              >
                <X size={17} />
              </button>
            </div>
          </div>

          {/* Sync status alert banner */}
          <div className="border-b border-[var(--lm-border)] bg-[var(--lm-bg-bubble)] px-6 py-2 text-[11px] text-[var(--lm-text-muted)]">
            设置变更会立即同步到当前打开的任务与后台 Agent 服务。
          </div>

          {/* Tab Content Panes */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* 1. General Tab */}
            {activeTab === 'general' && (
              <div className="space-y-6 max-w-xl">
                {/* Theme Selector */}
                <section className="space-y-2">
                  <label className="text-[13px] font-semibold text-[var(--lm-text-primary)]">外观主题</label>
                  <p className="text-[11.5px] text-[var(--lm-text-muted)]">选择适合您工作环境的界面色彩模式</p>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {THEME_OPTIONS.map((opt) => {
                      const Icon = opt.icon
                      const active = theme === opt.value
                      return (
                        <button
                          key={opt.value}
                          onClick={() => onThemeChange(opt.value)}
                          className={cn(
                            'flex items-center justify-center gap-2 rounded-xl border p-3 text-[13px] font-medium transition-all',
                            active
                              ? 'border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] text-[var(--lm-accent-text)] shadow-xs'
                              : 'border-[var(--lm-border)] bg-[var(--lm-bg-base)] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]',
                          )}
                        >
                          <Icon size={16} />
                          <span>{opt.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>

                {/* Thinking Depth */}
                <section className="space-y-2 pt-2 border-t border-[var(--lm-border)]" id="settings-thinking-level">
                  <label className="text-[13px] font-semibold text-[var(--lm-text-primary)]">思考深度预算 (Thinking Budget)</label>
                  <p className="text-[11.5px] text-[var(--lm-text-muted)]">
                    控制模型在调用工具前的推理预算。极速档位可大幅缩短等待时间（提速 60%~80%）。
                  </p>
                  <div className="space-y-1.5 pt-1">
                    {THINKING_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleThinkingChange(opt.value)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-all',
                          sessionThinkingLevel === opt.value
                            ? 'border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] text-[var(--lm-text-primary)]'
                            : 'border-[var(--lm-border)] bg-[var(--lm-bg-base)] hover:bg-[var(--lm-bg-hover)]',
                        )}
                      >
                        <div>
                          <div className="text-[13px] font-medium text-[var(--lm-text-primary)]">{opt.label}</div>
                          <div className="text-[11px] text-[var(--lm-text-muted)]">{opt.hint}</div>
                        </div>
                        {sessionThinkingLevel === opt.value && <Check size={16} className="text-[var(--lm-accent-text)]" />}
                      </button>
                    ))}
                  </div>
                </section>

                {/* Permission Mode */}
                <section className="space-y-2 pt-2 border-t border-[var(--lm-border)]">
                  <label className="text-[13px] font-semibold text-[var(--lm-text-primary)]">执行权限模式</label>
                  <p className="text-[11.5px] text-[var(--lm-text-muted)]">控制 Agent 在执行系统命令与写入文件时的授权策略</p>
                  <div className="space-y-1.5 pt-1">
                    {PERMISSION_MODES.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handlePermissionChange(opt.value)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-all',
                          permission === opt.value
                            ? 'border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] text-[var(--lm-text-primary)]'
                            : 'border-[var(--lm-border)] bg-[var(--lm-bg-base)] hover:bg-[var(--lm-bg-hover)]',
                        )}
                      >
                        <div>
                          <div className="text-[13px] font-medium text-[var(--lm-text-primary)]">{opt.label}</div>
                          <div className="text-[11px] text-[var(--lm-text-muted)]">{opt.hint}</div>
                        </div>
                        {permission === opt.value && <Check size={16} className="text-[var(--lm-accent-text)]" />}
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {/* 2. Models & API Tab */}
            {activeTab === 'models' && (
              <div className="space-y-5 max-w-xl">
                <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-4 space-y-3">
                  <h4 className="text-[13px] font-semibold text-[var(--lm-text-primary)]">默认推理模型</h4>
                  <p className="text-[11.5px] text-[var(--lm-text-muted)]">
                    LMCODE 默认采用深度适配的 DeepSeek V4 Flash / R1 推理架构，您也可以在输入框左下角随时自由切换。
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div className="rounded-lg border border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] p-2.5">
                      <div className="text-[12px] font-semibold text-[var(--lm-accent-text)]">DeepSeek V4 Flash</div>
                      <div className="text-[10px] text-[var(--lm-text-muted)]">官方高吞吐流式模型 · 推荐</div>
                    </div>
                    <div className="rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-2.5">
                      <div className="text-[12px] font-medium text-[var(--lm-text-primary)]">DeepSeek R1 / V3</div>
                      <div className="text-[10px] text-[var(--lm-text-muted)]">深度推理与全栈代码生成</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-4 space-y-3">
                  <h4 className="text-[13px] font-semibold text-[var(--lm-text-primary)]">API 密钥与连接凭证</h4>
                  <p className="text-[11.5px] text-[var(--lm-text-muted)]">
                    密钥已在系统本地安全加密保存，可通过环境变量或配置文件直接热加载。
                  </p>
                  <div className="space-y-2">
                    <label className="text-[11.5px] text-[var(--lm-text-secondary)]">DEEPSEEK_API_KEY</label>
                    <input
                      type="password"
                      placeholder="sk-••••••••••••••••••••••••"
                      defaultValue="sk-deepseek-enterprise-key-configured"
                      disabled
                      className="w-full rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[12.5px] font-mono text-[var(--lm-text-primary)]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 3. Plugins & MCP Tab */}
            {activeTab === 'plugins' && (
              <div className="space-y-5 max-w-xl">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-[13px] font-semibold text-[var(--lm-text-primary)]">已连接的 MCP 服务器与扩展</h4>
                    <p className="text-[11.5px] text-[var(--lm-text-muted)]">扩展 Agent 的文件系统、浏览器和数据库能力</p>
                  </div>
                </div>

                <div className="space-y-2">
                  {mcpServers.length > 0 ? (
                    mcpServers.map((srv) => (
                      <div
                        key={srv.name}
                        className="flex items-center justify-between rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-3"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="h-2 w-2 rounded-full bg-[var(--lm-success)]" />
                          <span className="text-[13px] font-medium text-[var(--lm-text-primary)]">{srv.name}</span>
                        </div>
                        <span className="text-[11px] text-[var(--lm-text-muted)] font-mono">{srv.status}</span>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--lm-border)] p-6 text-center text-[12px] text-[var(--lm-text-muted)]">
                      当前会话未挂载外部 MCP 服务器（已启用内置全量 Tools 工具套件）
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 4. Memory Tab */}
            {activeTab === 'memory' && (
              <div className="space-y-4 max-w-xl">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-[13px] font-semibold text-[var(--lm-text-primary)]">长期记忆库 (Semantic Memory)</h4>
                    <p className="text-[11.5px] text-[var(--lm-text-muted)]">Agent 跨会话沉淀的项目架构经验与踩坑记录</p>
                  </div>
                </div>

                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--lm-text-muted)]" />
                  <input
                    value={memorySearch}
                    onChange={(e) => setMemorySearch(e.target.value)}
                    placeholder="搜索沉淀的记忆..."
                    className="w-full rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] py-2 pl-9 pr-3 text-[12.5px] text-[var(--lm-text-primary)] outline-none focus:border-[var(--lm-accent)]"
                  />
                </div>

                <div className="space-y-2 max-h-[360px] overflow-y-auto">
                  {filteredMemories.length > 0 ? (
                    filteredMemories.map((m) => (
                      <div key={m.id} className="group rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-3 hover:border-[var(--lm-border-strong)]">
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-[12.5px] font-medium text-[var(--lm-text-primary)]">{m.userNeed || '通用经验'}</div>
                          <button
                            onClick={() => handleDeleteMemory(m.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 text-[var(--lm-text-muted)] hover:text-[var(--lm-error)]"
                            title="删除此条记忆"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        {m.outcome && <p className="mt-1 text-[11.5px] text-[var(--lm-text-secondary)]">{m.outcome}</p>}
                        {m.tags && m.tags.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {m.tags.map((t) => (
                              <span key={t} className="rounded bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[10px] text-[var(--lm-text-muted)] font-mono">
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--lm-border)] p-8 text-center text-[12px] text-[var(--lm-text-muted)]">
                      {loadingMemories ? '正在读取本地向量记忆...' : '暂无沉淀的记忆记录'}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 5. Remote LAN Tab */}
            {activeTab === 'remote' && (
              <div className="space-y-5 max-w-xl">
                <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-[13px] font-semibold text-[var(--lm-text-primary)]">局域网远程连接 (LAN Control)</h4>
                      <p className="text-[11.5px] text-[var(--lm-text-muted)]">允许同局域网内的手机或平板通过浏览器协同操作 Agent</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={remoteLanEnabled}
                      onChange={(e) => setRemoteLanEnabled(e.target.checked)}
                      className="h-4 w-4 rounded accent-[var(--lm-accent)]"
                    />
                  </div>

                  {remoteLanEnabled && (
                    <div className="mt-3 space-y-2 border-t border-[var(--lm-border)] pt-3">
                      <div className="text-[11.5px] text-[var(--lm-text-secondary)]">访问地址：</div>
                      <div className="flex items-center justify-between rounded-lg bg-[var(--lm-bg-surface)] p-2 font-mono text-[12px]">
                        <span>http://192.168.1.100:3000</span>
                        <button
                          onClick={() => copyToClipboard('http://192.168.1.100:3000', 'remote_url')}
                          className="flex items-center gap-1 text-[11px] text-[var(--lm-accent-text)] hover:underline"
                        >
                          {copiedKey === 'remote_url' ? <Check size={12} /> : <Copy size={12} />}
                          <span>{copiedKey === 'remote_url' ? '已复制' : '复制'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 6. About & Maintenance Tab */}
            {activeTab === 'about' && (
              <div className="space-y-5 max-w-xl">
                <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-4 space-y-3">
                  <h4 className="text-[13px] font-semibold text-[var(--lm-text-primary)]">会话维护与上下文管理</h4>
                  <div className="space-y-2">
                    <button
                      onClick={handleCompact}
                      disabled={!currentSessionId || compacting}
                      className="flex w-full items-center justify-between rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3.5 py-2.5 text-[13px] text-[var(--lm-text-primary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                    >
                      <span className="flex items-center gap-2">
                        <Minimize2 size={15} className="text-[var(--lm-accent-text)]" />
                        <span>压缩当前会话上下文 (/compact)</span>
                      </span>
                      {compactSuccess ? (
                        <span className="text-[11px] text-[var(--lm-success)] flex items-center gap-1">
                          <Check size={12} /> 已压缩
                        </span>
                      ) : compacting ? (
                        <span className="text-[11px] text-[var(--lm-text-muted)]">压缩中…</span>
                      ) : null}
                    </button>

                    <button
                      onClick={handleExport}
                      disabled={!currentSessionId}
                      className="flex w-full items-center justify-between rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3.5 py-2.5 text-[13px] text-[var(--lm-text-primary)] hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                    >
                      <span className="flex items-center gap-2">
                        <Download size={15} className="text-[var(--lm-text-muted)]" />
                        <span>导出当前会话为 Markdown / ZIP</span>
                      </span>
                      {exportSuccess && (
                        <span className="text-[11px] text-[var(--lm-success)] flex items-center gap-1">
                          <Check size={12} /> 已导出
                        </span>
                      )}
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-4 space-y-2">
                  <div className="text-[13px] font-semibold text-[var(--lm-text-primary)]">LMCODE Desktop</div>
                  <p className="text-[11.5px] text-[var(--lm-text-secondary)] leading-relaxed">
                    基于 deepseek-harness 模板体系构建的轻量级、高自主性 AI Agent 桌面工程工作台。
                  </p>
                  <div className="pt-2 flex items-center gap-4 text-[12px] text-[var(--lm-text-muted)]">
                    <span>版本: {version || 'v0.6.13'}</span>
                    <a
                      href="https://github.com/Lyin01/LMcode-desktop"
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-[var(--lm-accent-text)] hover:underline"
                    >
                      <span>GitHub 开源主页</span>
                      <ExternalLink size={11} />
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
