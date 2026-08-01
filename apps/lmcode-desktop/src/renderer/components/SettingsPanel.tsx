import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  CircleHelp,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react'
import { ModelProvidersPanel } from '@/components/settings/ModelProvidersPanel'
import { buildModelEntries } from '@/lib/models'
import { THINKING_OPTIONS, type ThinkingEffort } from '@/lib/thinking'
import type { ThemePref } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useConfigStore } from '@/stores/config-store'
import { useSessionStore } from '@/stores/session-store'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  onOpenExtensions: () => void
  onOpenKeyboardShortcuts: () => void
  theme: ThemePref
  onThemeChange: (theme: ThemePref) => void
}

type PermissionMode = 'manual' | 'auto' | 'yolo'
type SavingField = 'model' | 'thinkingLevel' | 'permission' | null
type SettingsGroup = '设置' | '集成' | '支持'
type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'models'
  | 'permissions'
  | 'shortcuts'
  | 'extensions'
  | 'about'

interface SettingsSectionDefinition {
  readonly id: SettingsSectionId
  readonly label: string
  readonly description: string
  readonly keywords: string
  readonly group: SettingsGroup
  readonly icon: LucideIcon
}

const DEFAULT_PERMISSION_MODE: {
  value: PermissionMode
  label: string
  hint: string
} = {
  value: 'manual',
  label: '手动审批',
  hint: '执行需要授权的操作前先询问。',
}

const PERMISSION_MODES: readonly typeof DEFAULT_PERMISSION_MODE[] = [
  DEFAULT_PERMISSION_MODE,
  {
    value: 'auto',
    label: '自动允许',
    hint: '自动批准普通操作，关键安全边界仍然生效。',
  },
  {
    value: 'yolo',
    label: 'YOLO 模式',
    hint: '尽量减少打断，适合受控或隔离的工作环境。',
  },
]

const THEME_OPTIONS: readonly {
  value: ThemePref
  label: string
  icon: LucideIcon
}[] = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '系统', icon: Monitor },
]

const SETTINGS_GROUPS: readonly SettingsGroup[] = ['设置', '集成', '支持']

const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: 'general',
    label: '常规',
    description: '控制 Agent 的默认工作方式',
    keywords: 'agent 思考 深度 推理 任务 默认 行为',
    group: '设置',
    icon: Settings2,
  },
  {
    id: 'appearance',
    label: '外观',
    description: '主题与界面显示',
    keywords: '亮色 暗色 深色 系统 主题 颜色',
    group: '设置',
    icon: Palette,
  },
  {
    id: 'models',
    label: '模型',
    description: '当前模型与供应商',
    keywords: '模型 provider 供应商 api key base url 上下文',
    group: '设置',
    icon: Boxes,
  },
  {
    id: 'permissions',
    label: '权限',
    description: '审批和自动执行策略',
    keywords: '手动 审批 自动 允许 yolo 安全',
    group: '设置',
    icon: ShieldCheck,
  },
  {
    id: 'shortcuts',
    label: '键盘快捷键',
    description: '查看桌面操作快捷键',
    keywords: '快捷键 keyboard ctrl command 导航',
    group: '设置',
    icon: Keyboard,
  },
  {
    id: 'extensions',
    label: '扩展',
    description: '技能与 MCP 集成',
    keywords: '插件 skill 技能 mcp 工具 集成',
    group: '集成',
    icon: Puzzle,
  },
  {
    id: 'about',
    label: '关于',
    description: '版本与本地数据目录',
    keywords: '版本 version 数据 目录 home lmcode desktop',
    group: '支持',
    icon: CircleHelp,
  },
]

const selectClass = 'lm-settings-select'

function SettingsPageHeader({
  title,
  description,
  backLabel,
  onBack,
}: {
  title: string
  description: string
  backLabel?: string
  onBack?: () => void
}) {
  return (
    <header className="lm-settings-page-header">
      {onBack && backLabel && (
        <button type="button" className="lm-settings-inline-back" onClick={onBack}>
          <ArrowLeft size={14} />
          {backLabel}
        </button>
      )}
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  )
}

function SettingsSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="lm-settings-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="lm-settings-card">{children}</div>
}

function SettingRow({
  title,
  description,
  labelFor,
  children,
  alignTop = false,
}: {
  title: string
  description: string
  labelFor?: string
  children: ReactNode
  alignTop?: boolean
}) {
  const titleNode = labelFor ? (
    <label htmlFor={labelFor}>{title}</label>
  ) : (
    <span className="lm-settings-row-title">{title}</span>
  )

  return (
    <div className={cn('lm-settings-row', alignTop && 'lm-settings-row-top')}>
      <div className="lm-settings-row-copy">
        {titleNode}
        <p>{description}</p>
      </div>
      <div className="lm-settings-row-control">{children}</div>
    </div>
  )
}

function GeneralSettingsPage({
  currentSessionId,
  thinkingLevel,
  saving,
  onThinkingChange,
}: {
  currentSessionId: string | null
  thinkingLevel: ThinkingEffort
  saving: SavingField
  onThinkingChange: (value: ThinkingEffort) => Promise<void>
}) {
  const thinkingHint =
    THINKING_OPTIONS.find((option) => option.value === thinkingLevel)?.hint ?? ''

  return (
    <>
      <SettingsPageHeader
        title="常规"
        description="控制 LMCODE Agent 在当前任务和后续任务中的默认工作方式。"
      />
      <SettingsSection title="Agent 行为">
        <SettingsCard>
          <SettingRow
            title="思考深度"
            description={thinkingHint || '选择模型在回答前使用的推理强度。'}
            labelFor="settings-thinking-level"
          >
            <select
              id="settings-thinking-level"
              value={thinkingLevel}
              disabled={saving === 'thinkingLevel'}
              onChange={(event) => {
                void onThinkingChange(event.target.value as ThinkingEffort)
              }}
              className={selectClass}
            >
              {THINKING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            title="当前任务"
            description={
              currentSessionId
                ? '设置变更会立即同步到当前打开的任务。'
                : '开始新任务后，当前偏好会自动应用。'
            }
          >
            <span
              className={cn(
                'lm-settings-status',
                currentSessionId && 'lm-settings-status-live',
              )}
            >
              <span aria-hidden="true" />
              {currentSessionId ? '已连接' : '尚未开始'}
            </span>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}

function AppearanceSettingsPage({
  theme,
  onThemeChange,
}: {
  theme: ThemePref
  onThemeChange: (theme: ThemePref) => void
}) {
  return (
    <>
      <SettingsPageHeader
        title="外观"
        description="选择更适合当前环境的界面主题，修改会立即生效。"
      />
      <SettingsSection title="主题">
        <SettingsCard>
          <SettingRow
            title="界面外观"
            description="跟随系统时，LMCODE 会响应操作系统的明暗模式。"
          >
            <div className="lm-settings-segmented" role="radiogroup" aria-label="界面外观">
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon
                const active = theme === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onThemeChange(option.value)}
                    className={cn(active && 'lm-settings-segmented-active')}
                  >
                    <Icon size={15} />
                    {option.label}
                  </button>
                )
              })}
            </div>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}

function ModelsSettingsPage({
  currentSessionId,
  effectiveModel,
  modelOptions,
  providerCount,
  modelCount,
  saving,
  onModelChange,
  onOpenProviders,
}: {
  currentSessionId: string | null
  effectiveModel: string
  modelOptions: readonly { id: string; label: string; provider: string }[]
  providerCount: number
  modelCount: number
  saving: SavingField
  onModelChange: (value: string) => Promise<void>
  onOpenProviders: () => void
}) {
  return (
    <>
      <SettingsPageHeader
        title="模型"
        description="切换当前任务使用的模型，并管理自定义模型供应商。"
      />
      <SettingsSection title="当前任务">
        <SettingsCard>
          <SettingRow
            title="模型"
            description={
              currentSessionId
                ? '切换后会用于当前任务接下来的消息。'
                : '开始任务后可在此切换模型。'
            }
            labelFor="settings-active-model"
          >
            <select
              id="settings-active-model"
              value={effectiveModel}
              disabled={!currentSessionId || saving === 'model' || modelOptions.length === 0}
              onChange={(event) => {
                void onModelChange(event.target.value)
              }}
              className={selectClass}
            >
              {!effectiveModel && <option value="">选择模型</option>}
              {modelOptions.length === 0 && <option value="">未配置模型</option>}
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.provider ? `${entry.label} (${entry.provider})` : entry.label}
                </option>
              ))}
            </select>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="配置">
        <SettingsCard>
          <SettingRow
            title="模型供应商"
            description={`已配置 ${providerCount} 个供应商、${modelCount} 个模型。API Key 由主进程安全保存。`}
          >
            <button
              type="button"
              className="lm-settings-action"
              onClick={onOpenProviders}
              aria-label="打开模型供应商设置"
            >
              管理
              <ChevronRight size={15} />
            </button>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}

function ProvidersSettingsPage({ onBack }: { onBack: () => void }) {
  return (
    <>
      <SettingsPageHeader
        title="模型供应商"
        description="添加供应商、保存凭据，并配置可在任务中选择的模型。"
        backLabel="返回模型"
        onBack={onBack}
      />
      <SettingsSection title="供应商与模型">
        <div className="lm-settings-provider-surface">
          <ModelProvidersPanel />
        </div>
      </SettingsSection>
    </>
  )
}

function PermissionsSettingsPage({
  permission,
  saving,
  onPermissionChange,
}: {
  permission: string
  saving: SavingField
  onPermissionChange: (value: PermissionMode) => Promise<void>
}) {
  const activeMode =
    PERMISSION_MODES.find((mode) => mode.value === permission) ?? DEFAULT_PERMISSION_MODE

  return (
    <>
      <SettingsPageHeader
        title="权限"
        description="决定 Agent 在执行工具和修改工作区时何时需要你的确认。"
      />
      <SettingsSection title="审批策略">
        <SettingsCard>
          <SettingRow
            title="权限模式"
            description={activeMode.hint}
            labelFor="settings-permission-mode"
          >
            <select
              id="settings-permission-mode"
              value={activeMode.value}
              disabled={saving === 'permission'}
              onChange={(event) => {
                void onPermissionChange(event.target.value as PermissionMode)
              }}
              className={selectClass}
            >
              {PERMISSION_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>

      {activeMode.value === 'yolo' && (
        <div className="lm-settings-callout">
          <ShieldCheck size={17} />
          <div>
            <strong>建议只在受控环境中使用</strong>
            <p>敏感路径和系统边界仍会受保护，但普通操作会减少确认。</p>
          </div>
        </div>
      )}
    </>
  )
}

function ShortcutKeys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="lm-settings-shortcut-keys" aria-label={keys.join(' 加 ')}>
      {keys.map((key) => <kbd key={key}>{key}</kbd>)}
    </span>
  )
}

function ShortcutsSettingsPage({ onOpenAll }: { onOpenAll: () => void }) {
  const modifier =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'

  return (
    <>
      <SettingsPageHeader
        title="键盘快捷键"
        description="用键盘快速打开常用工作区和命令。"
      />
      <SettingsSection title="常用">
        <SettingsCard>
          <SettingRow title="打开设置" description="在应用中的任意位置打开此工作区。">
            <ShortcutKeys keys={[modifier, ',']} />
          </SettingRow>
          <SettingRow title="搜索任务" description="聚焦侧栏搜索并快速切换任务。">
            <ShortcutKeys keys={[modifier, 'K']} />
          </SettingRow>
          <SettingRow title="命令面板" description="查找并执行当前可用命令。">
            <ShortcutKeys keys={[modifier, 'Shift', 'P']} />
          </SettingRow>
        </SettingsCard>
      </SettingsSection>
      <button type="button" className="lm-settings-primary-action" onClick={onOpenAll}>
        <Keyboard size={16} />
        查看全部快捷键
      </button>
    </>
  )
}

function ExtensionsSettingsPage({ onOpenExtensions }: { onOpenExtensions: () => void }) {
  return (
    <>
      <SettingsPageHeader
        title="扩展"
        description="集中管理 Agent 可调用的技能与 MCP 工具。"
      />
      <SettingsSection title="集成">
        <SettingsCard>
          <SettingRow
            title="技能与 MCP"
            description="查看已安装扩展、可用技能和 MCP 连接状态。"
          >
            <button
              type="button"
              className="lm-settings-action"
              onClick={onOpenExtensions}
            >
              打开扩展
              <ChevronRight size={15} />
            </button>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}

function AboutSettingsPage({
  version,
  homeDir,
  providerCount,
  modelCount,
}: {
  version: string
  homeDir: string
  providerCount: number
  modelCount: number
}) {
  return (
    <>
      <SettingsPageHeader
        title="关于"
        description="查看应用版本、本地数据位置和当前模型配置概览。"
      />
      <SettingsSection title="LMCODE Desktop">
        <SettingsCard>
          <SettingRow title="版本" description="当前安装的桌面客户端版本。">
            <span className="lm-settings-value">{version ? `v${version}` : '正在读取…'}</span>
          </SettingRow>
          <SettingRow title="本地数据目录" description="配置、记忆和任务数据保存在此目录。">
            <code className="lm-settings-path" title={homeDir || undefined}>
              {homeDir || '正在读取…'}
            </code>
          </SettingRow>
          <SettingRow title="模型配置" description="当前可用的自定义供应商与模型数量。">
            <span className="lm-settings-value">
              {providerCount} 个供应商 · {modelCount} 个模型
            </span>
          </SettingRow>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}

export function SettingsPanel({
  open,
  onClose,
  onOpenExtensions,
  onOpenKeyboardShortcuts,
  theme,
  onThemeChange,
}: SettingsPanelProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessionThinkingLevel = useSessionStore((state) => state.thinkingLevel)
  const sessionPermission = useSessionStore((state) => state.permission)
  const sessionModel = useSessionStore((state) => state.model)
  const setThinkingPreference = useSessionStore((state) => state.setThinkingPreference)
  const setPermissionPreference = useSessionStore((state) => state.setPermissionPreference)
  const config = useConfigStore((state) => state.config)
  const homeDir = useConfigStore((state) => state.homeDir)

  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState<SavingField>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>('general')
  const [searchQuery, setSearchQuery] = useState('')
  const [providersOpen, setProvidersOpen] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open) return
    setSelectedSection('general')
    setSearchQuery('')
    setProvidersOpen(false)
    setError(null)
  }, [open])

  useEffect(() => {
    if (!open || version) return
    void window.lmcodeAPI.getVersion().then(setVersion).catch(() => {})
  }, [open, version])

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement
    panelRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [open, onClose])

  const models = useMemo(() => (config ? buildModelEntries(config) : []), [config])
  const effectiveModel = sessionModel || config?.defaultModel || ''
  const modelOptions = useMemo(() => {
    if (effectiveModel && !models.some((model) => model.id === effectiveModel)) {
      return [{ id: effectiveModel, label: effectiveModel, provider: '' }, ...models]
    }
    return models
  }, [effectiveModel, models])

  const providerCount = Object.keys(config?.providers ?? {}).length
  const modelCount = Object.keys(config?.models ?? {}).length
  const searchTerms = searchQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visibleSections = searchTerms.length === 0
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((section) => {
        const searchText = `${section.label} ${section.description} ${section.keywords}`
          .toLocaleLowerCase()
        return searchTerms.every((term) => searchText.includes(term))
      })
  const activeSection = visibleSections.some((section) => section.id === selectedSection)
    ? selectedSection
    : visibleSections[0]?.id ?? null

  const handleThinkingChange = async (value: ThinkingEffort): Promise<void> => {
    setSaving('thinkingLevel')
    setError(null)
    try {
      await setThinkingPreference(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法更新思考深度')
    } finally {
      setSaving(null)
    }
  }

  const handlePermissionChange = async (value: PermissionMode): Promise<void> => {
    setSaving('permission')
    setError(null)
    try {
      await setPermissionPreference(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法更新权限模式')
    } finally {
      setSaving(null)
    }
  }

  const handleModelChange = async (value: string): Promise<void> => {
    if (!currentSessionId) return
    setSaving('model')
    setError(null)
    try {
      await window.lmcodeAPI.setModel(currentSessionId, value)
      useSessionStore.getState().updateSessionStatus({ model: value })
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法更新模型')
    } finally {
      setSaving(null)
    }
  }

  if (!open) return null

  let page: ReactNode
  if (providersOpen && activeSection === 'models') {
    page = <ProvidersSettingsPage onBack={() => setProvidersOpen(false)} />
  } else {
    switch (activeSection) {
      case 'general':
        page = (
          <GeneralSettingsPage
            currentSessionId={currentSessionId}
            thinkingLevel={sessionThinkingLevel}
            saving={saving}
            onThinkingChange={handleThinkingChange}
          />
        )
        break
      case 'appearance':
        page = <AppearanceSettingsPage theme={theme} onThemeChange={onThemeChange} />
        break
      case 'models':
        page = (
          <ModelsSettingsPage
            currentSessionId={currentSessionId}
            effectiveModel={effectiveModel}
            modelOptions={modelOptions}
            providerCount={providerCount}
            modelCount={modelCount}
            saving={saving}
            onModelChange={handleModelChange}
            onOpenProviders={() => setProvidersOpen(true)}
          />
        )
        break
      case 'permissions':
        page = (
          <PermissionsSettingsPage
            permission={sessionPermission}
            saving={saving}
            onPermissionChange={handlePermissionChange}
          />
        )
        break
      case 'shortcuts':
        page = <ShortcutsSettingsPage onOpenAll={onOpenKeyboardShortcuts} />
        break
      case 'extensions':
        page = <ExtensionsSettingsPage onOpenExtensions={onOpenExtensions} />
        break
      case 'about':
        page = (
          <AboutSettingsPage
            version={version}
            homeDir={homeDir}
            providerCount={providerCount}
            modelCount={modelCount}
          />
        )
        break
      default:
        page = (
          <div className="lm-settings-empty">
            <Search size={22} />
            <strong>没有匹配的设置</strong>
            <p>尝试搜索“模型”“主题”或“权限”。</p>
          </div>
        )
    }
  }

  return (
    <section
      ref={panelRef}
      className="lm-settings-shell"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      tabIndex={-1}
    >
      <aside className="lm-settings-sidebar">
        <button type="button" className="lm-settings-back" onClick={onClose}>
          <ArrowLeft size={16} />
          返回应用
        </button>

        <label className="lm-settings-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value)
              setProvidersOpen(false)
              setError(null)
            }}
            placeholder="搜索设置…"
            aria-label="搜索设置"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <nav className="lm-settings-nav" aria-label="设置分类">
          {SETTINGS_GROUPS.map((group) => {
            const sections = visibleSections.filter((section) => section.group === group)
            if (sections.length === 0) return null
            return (
              <div key={group} className="lm-settings-nav-group">
                <p>{group}</p>
                {sections.map((section) => {
                  const Icon = section.icon
                  const active = activeSection === section.id
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => {
                        setSelectedSection(section.id)
                        setProvidersOpen(false)
                        setError(null)
                      }}
                      className={cn(active && 'lm-settings-nav-active')}
                      aria-current={active ? 'page' : undefined}
                      title={section.description}
                    >
                      <Icon size={16} />
                      <span>{section.label}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>

        <footer className="lm-settings-sidebar-footer">
          <span className="lm-settings-brand-mark" aria-hidden="true">L</span>
          <span>LMCODE Desktop{version ? ` v${version}` : ''}</span>
        </footer>
      </aside>

      <main className="lm-settings-main">
        <header className="lm-settings-topbar">
          <span>设置</span>
          <button type="button" onClick={onClose} aria-label="关闭设置" title="关闭设置">
            <X size={17} />
          </button>
        </header>
        <div className="lm-settings-scroll">
          <div className="lm-settings-content">{page}</div>
        </div>
      </main>

      {error && (
        <div className="lm-settings-error" role="alert">
          <Sparkles size={15} />
          <span>设置保存失败：{error}</span>
        </div>
      )}
    </section>
  )
}
