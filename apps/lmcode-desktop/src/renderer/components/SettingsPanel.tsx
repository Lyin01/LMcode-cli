import { useEffect, useState, useRef, useCallback } from 'react'
import { X, Sun, Moon, Monitor, Minimize2, Download, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import type { ThemePref } from '@/lib/theme'
import { THINKING_OPTIONS, type ThinkingEffort } from '@/lib/thinking'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  theme: ThemePref
  onThemeChange: (theme: ThemePref) => void
}

const PERMISSION_MODES = [
  { value: 'manual', label: '手动审批' },
  { value: 'auto', label: '自动允许' },
  { value: 'yolo', label: 'YOLO 模式' },
]

const THEME_OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '系统', icon: Monitor },
]

const selectClass =
  'w-full rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[14px] text-[var(--lm-text-primary)] outline-none transition-colors focus:border-[var(--lm-accent)] disabled:cursor-not-allowed disabled:opacity-50'

export function SettingsPanel({ open, onClose, theme, onThemeChange }: SettingsPanelProps) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessionThinkingLevel = useSessionStore((s) => s.thinkingLevel)
  const sessionPermission = useSessionStore((s) => s.permission)
  const setThinkingPreference = useSessionStore((s) => s.setThinkingPreference)

  const [permission, setPermission] = useState('manual')
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [compactSuccess, setCompactSuccess] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPermission(sessionPermission)
  }, [sessionPermission])

  useEffect(() => {
    if (!open || version) return
    void window.lmcodeAPI.getVersion().then(setVersion).catch(() => {})
  }, [open, version])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open && panelRef.current) panelRef.current.focus()
  }, [open])

  const handleSessionSettingChange = useCallback(
    async (key: string, value: string, sessionMethod: (id: string, val: string) => Promise<void>) => {
      setSaving(key)
      try {
        if (currentSessionId) await sessionMethod(currentSessionId, value)
      } catch (err) {
        console.error(`Failed to update ${key}:`, err)
      } finally {
        setSaving(null)
      }
    },
    [currentSessionId],
  )

  const handleThinkingChange = async (value: ThinkingEffort) => {
    setSaving('thinkingLevel')
    try {
      await setThinkingPreference(value)
    } catch (err) {
      console.error('Failed to update thinkingLevel:', err)
    } finally {
      setSaving(null)
    }
  }

  const handlePermissionChange = async (value: string) => {
    setPermission(value)
    await handleSessionSettingChange('permission', value, window.lmcodeAPI.setPermission)
  }

  const handleCompact = async () => {
    if (!currentSessionId || compacting) return
    setCompacting(true)
    try {
      await window.lmcodeAPI.compactSession(currentSessionId)
      setCompactSuccess(true)
      setTimeout(() => setCompactSuccess(false), 2000)
    } catch (err) {
      console.error('Failed to compact session:', err)
    } finally {
      setCompacting(false)
    }
  }

  const handleExport = async () => {
    if (!currentSessionId || exporting) return
    setExporting(true)
    try {
      await window.lmcodeAPI.exportSession(currentSessionId)
      setExportSuccess(true)
      setTimeout(() => setExportSuccess(false), 2000)
    } catch (err) {
      console.error('Failed to export session:', err)
    } finally {
      setExporting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex" ref={panelRef} tabIndex={-1}>
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative z-10 ml-auto flex h-full w-[380px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3.5">
          <h2 className="text-[15px] font-semibold text-[var(--lm-text-primary)]">设置与维护</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {/* Theme */}
          <section>
            <label className="mb-2 block text-[12px] font-medium text-[var(--lm-text-secondary)]">外观主题</label>
            <div className="flex gap-1.5 rounded-xl bg-[var(--lm-bg-hover)] p-1">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon
                const active = theme === opt.value
                return (
                  <button
                    key={opt.value}
                    onClick={() => onThemeChange(opt.value)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-medium transition-colors',
                      active
                        ? 'bg-[var(--lm-bg-surface)] text-[var(--lm-text-primary)] shadow-[var(--lm-shadow-soft)]'
                        : 'text-[var(--lm-text-muted)] hover:text-[var(--lm-text-secondary)]',
                    )}
                  >
                    <Icon size={15} />
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </section>

          {/* Thinking Level */}
          <section>
            <label className="mb-1.5 block text-[12px] font-medium text-[var(--lm-text-secondary)]">思考深度</label>
            <select
              value={sessionThinkingLevel}
              disabled={saving === 'thinkingLevel'}
              onChange={(e) => handleThinkingChange(e.target.value as ThinkingEffort)}
              className={selectClass}
            >
              {THINKING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </section>

          {/* Permission Mode */}
          <section>
            <label className="mb-1.5 block text-[12px] font-medium text-[var(--lm-text-secondary)]">权限执行模式</label>
            <select
              value={permission}
              disabled={saving === 'permission'}
              onChange={(e) => handlePermissionChange(e.target.value)}
              className={selectClass}
            >
              {PERMISSION_MODES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <p className="mt-1.5 text-[11px] text-[var(--lm-text-muted)]">
              模型可在输入框左下角快捷切换。
            </p>
          </section>

          {/* Session Maintenance */}
          <section className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
            <h3 className="mb-2 text-[12px] font-semibold text-[var(--lm-text-primary)]">会话维护与管理</h3>
            <div className="space-y-2">
              <button
                onClick={handleCompact}
                disabled={!currentSessionId || compacting}
                className="flex w-full items-center justify-between rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-base)] px-3 py-2 text-[13px] text-[var(--lm-text-primary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
              >
                <span className="flex items-center gap-2">
                  <Minimize2 size={14} className="text-[var(--lm-accent-text)]" />
                  <span>压缩上下文 (/compact)</span>
                </span>
                {compactSuccess ? (
                  <span className="flex items-center gap-1 text-[11px] text-[var(--lm-success)]">
                    <Check size={12} /> 已压缩
                  </span>
                ) : compacting ? (
                  <span className="text-[11px] text-[var(--lm-text-muted)]">压缩中…</span>
                ) : null}
              </button>

              <button
                onClick={handleExport}
                disabled={!currentSessionId || exporting}
                className="flex w-full items-center justify-between rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-base)] px-3 py-2 text-[13px] text-[var(--lm-text-primary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
              >
                <span className="flex items-center gap-2">
                  <Download size={14} className="text-[var(--lm-text-muted)]" />
                  <span>导出当前会话历史</span>
                </span>
                {exportSuccess && (
                  <span className="flex items-center gap-1 text-[11px] text-[var(--lm-success)]">
                    <Check size={12} /> 已导出
                  </span>
                )}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-[var(--lm-text-muted)]">
              压缩可提取长会话核心记忆并清理冗余历史，释放上下文空间。
            </p>
          </section>

          {/* Quick Shortcuts */}
          <section className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
            <h3 className="mb-2 text-[12px] font-semibold text-[var(--lm-text-primary)]">常用快捷键</h3>
            <div className="space-y-1.5 text-[11.5px]">
              <div className="flex justify-between text-[var(--lm-text-secondary)]">
                <span>发送消息</span>
                <kbd className="rounded bg-[var(--lm-bg-code)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--lm-text-muted)]">Ctrl + Enter</kbd>
              </div>
              <div className="flex justify-between text-[var(--lm-text-secondary)]">
                <span>斜杠命令菜单</span>
                <kbd className="rounded bg-[var(--lm-bg-code)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--lm-text-muted)]">/</kbd>
              </div>
              <div className="flex justify-between text-[var(--lm-text-secondary)]">
                <span>取消生成 / 关闭弹窗</span>
                <kbd className="rounded bg-[var(--lm-bg-code)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--lm-text-muted)]">Esc</kbd>
              </div>
            </div>
          </section>
        </div>

        <div className="border-t border-[var(--lm-border)] px-4 py-3">
          <p className="text-[11px] text-[var(--lm-text-muted)]">
            LMCODE Desktop{version ? ` v${version}` : ''} · Enterprise Edition
          </p>
        </div>
      </div>
    </div>
  )
}
