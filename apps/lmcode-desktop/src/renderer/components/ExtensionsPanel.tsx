import { useEffect, useState, useCallback } from 'react'
import {
  X, Blocks, Zap, Server, RefreshCw, Square, Trash2, Plus,
  Loader2, AlertTriangle, CheckCircle2, Play,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'

interface ExtensionsPanelProps {
  open: boolean
  onClose: () => void
}

type Tab = 'skills' | 'mcp'

const SOURCE_LABEL: Record<SkillSummary['source'], string> = {
  builtin: '内置',
  user: '用户',
  extra: '扩展',
  project: '项目',
}

const MCP_STATUS: Record<
  McpServerInfo['status'],
  { label: string; color: string; dot: string }
> = {
  connected: { label: '已连接', color: 'text-[var(--lm-success)]', dot: 'bg-[var(--lm-success)]' },
  pending: { label: '连接中', color: 'text-[var(--lm-warning)]', dot: 'bg-[var(--lm-warning)]' },
  failed: { label: '失败', color: 'text-[var(--lm-error)]', dot: 'bg-[var(--lm-error)]' },
  disabled: { label: '已禁用', color: 'text-[var(--lm-text-muted)]', dot: 'bg-[var(--lm-text-muted)]' },
  'needs-auth': { label: '需授权', color: 'text-[var(--lm-warning)]', dot: 'bg-[var(--lm-warning)]' },
}

export function ExtensionsPanel({ open, onClose }: ExtensionsPanelProps) {
  const sessionId = useSessionStore((s) => s.currentSessionId)
  const [tab, setTab] = useState<Tab>('skills')

  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  // Add-server form
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'stdio' | 'http'>('stdio')
  const [newTarget, setNewTarget] = useState('')

  const refresh = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      if (tab === 'skills') {
        setSkills(await window.lmcodeAPI.listSkills(sessionId))
      } else {
        setServers(await window.lmcodeAPI.listMcpServers(sessionId))
      }
    } catch (err) {
      console.error('Failed to load extensions:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId, tab])

  useEffect(() => {
    if (open) refresh()
  }, [open, tab, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const activateSkill = async (name: string) => {
    if (!sessionId) return
    try {
      await window.lmcodeAPI.activateSkill(sessionId, name)
      onClose() // skill runs in the chat — show it
    } catch (err) {
      console.error('Failed to activate skill:', err)
    }
  }

  const mcpAction = async (
    fn: (sid: string, name: string) => Promise<void>,
    name: string,
  ) => {
    if (!sessionId) return
    setBusy(name)
    try {
      await fn(sessionId, name)
      await refresh()
    } catch (err) {
      console.error('MCP action failed:', err)
    } finally {
      setBusy(null)
    }
  }

  const addServer = async () => {
    if (!sessionId || !newName.trim() || !newTarget.trim()) return
    setBusy('__add__')
    try {
      const config =
        newType === 'stdio'
          ? { command: newTarget.trim() }
          : { url: newTarget.trim() }
      await window.lmcodeAPI.addMcpServer(sessionId, newName.trim(), config)
      setNewName('')
      setNewTarget('')
      setShowAdd(false)
      await refresh()
    } catch (err) {
      console.error('Failed to add MCP server:', err)
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 ml-auto flex h-full w-[420px] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Blocks size={16} className="text-[var(--lm-accent-text)]" />
            <h2 className="text-[15px] font-semibold text-[var(--lm-text-primary)]">扩展</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[var(--lm-border)] px-3 pt-2">
          {([['skills', '技能', Zap], ['mcp', 'MCP', Server]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-[13px] font-medium transition-colors',
                tab === id
                  ? 'border-b-2 border-[var(--lm-accent)] text-[var(--lm-text-primary)]'
                  : 'border-b-2 border-transparent text-[var(--lm-text-muted)] hover:text-[var(--lm-text-secondary)]',
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
          <button
            onClick={refresh}
            className="ml-auto mb-1 self-end rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'lm-spin' : ''} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {!sessionId && (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--lm-text-muted)]">
              请先创建或选择一个会话
            </p>
          )}

          {/* ── Skills ── */}
          {sessionId && tab === 'skills' && (
            <>
              {!loading && skills.length === 0 && (
                <p className="px-2 py-8 text-center text-[13px] text-[var(--lm-text-muted)]">暂无技能</p>
              )}
              <div className="space-y-1.5">
                {skills.map((sk) => (
                  <div
                    key={`${sk.source}:${sk.name}`}
                    className="group flex items-start gap-2.5 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3"
                  >
                    <Zap size={15} className="mt-0.5 shrink-0 text-[var(--lm-accent-text)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-[var(--lm-text-primary)]">
                          /{sk.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[10px] text-[var(--lm-text-muted)]">
                          {SOURCE_LABEL[sk.source]}
                        </span>
                      </div>
                      {sk.description && (
                        <p className="mt-0.5 line-clamp-2 text-[12px] text-[var(--lm-text-secondary)]">
                          {sk.description}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => activateSkill(sk.name)}
                      className="shrink-0 rounded-lg p-1.5 text-[var(--lm-text-muted)] opacity-0 transition-all hover:bg-[var(--lm-accent-soft)] hover:text-[var(--lm-accent-text)] group-hover:opacity-100"
                      title="运行技能"
                    >
                      <Play size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── MCP ── */}
          {sessionId && tab === 'mcp' && (
            <>
              {/* Add form */}
              {showAdd ? (
                <div className="mb-3 space-y-2 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="服务器名称"
                    className="w-full rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--lm-accent)]"
                  />
                  <div className="flex gap-1.5 rounded-lg bg-[var(--lm-bg-hover)] p-1">
                    {(['stdio', 'http'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setNewType(t)}
                        className={cn(
                          'flex-1 rounded-md py-1 text-[12px] font-medium transition-colors',
                          newType === t
                            ? 'bg-[var(--lm-bg-surface)] text-[var(--lm-text-primary)] shadow-[var(--lm-shadow-soft)]'
                            : 'text-[var(--lm-text-muted)]',
                        )}
                      >
                        {t === 'stdio' ? 'stdio (命令)' : 'http (URL)'}
                      </button>
                    ))}
                  </div>
                  <input
                    value={newTarget}
                    onChange={(e) => setNewTarget(e.target.value)}
                    placeholder={newType === 'stdio' ? '启动命令，如 npx -y @foo/mcp' : '服务器 URL'}
                    className="w-full rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-base)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--lm-accent)]"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setShowAdd(false)}
                      className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]"
                    >
                      取消
                    </button>
                    <button
                      onClick={addServer}
                      disabled={!newName.trim() || !newTarget.trim() || busy === '__add__'}
                      className="rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-accent-fg)] hover:bg-[var(--lm-accent-hover)] disabled:opacity-50"
                    >
                      添加
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowAdd(true)}
                  className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--lm-border-strong)] py-2.5 text-[13px] text-[var(--lm-text-secondary)] transition-colors hover:border-[var(--lm-accent)] hover:text-[var(--lm-accent-text)]"
                >
                  <Plus size={15} />
                  添加 MCP 服务器
                </button>
              )}

              {!loading && servers.length === 0 && (
                <p className="px-2 py-6 text-center text-[13px] text-[var(--lm-text-muted)]">
                  暂无 MCP 服务器
                </p>
              )}

              <div className="space-y-1.5">
                {servers.map((srv) => {
                  const st = MCP_STATUS[srv.status]
                  const isBusy = busy === srv.name
                  return (
                    <div
                      key={srv.name}
                      className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', st.dot)} />
                        <span className="truncate text-[13px] font-medium text-[var(--lm-text-primary)]">
                          {srv.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[10px] text-[var(--lm-text-muted)]">
                          {srv.transport}
                        </span>
                        <span className={cn('ml-auto shrink-0 text-[11px]', st.color)}>{st.label}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-[var(--lm-text-muted)]">
                        <span className="flex items-center gap-1">
                          {srv.status === 'connected' ? (
                            <CheckCircle2 size={11} className="text-[var(--lm-success)]" />
                          ) : srv.error ? (
                            <AlertTriangle size={11} className="text-[var(--lm-error)]" />
                          ) : null}
                          {srv.toolCount} 个工具
                        </span>
                        {isBusy && <Loader2 size={11} className="lm-spin" />}
                      </div>
                      {srv.error && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-[var(--lm-error)]">{srv.error}</p>
                      )}
                      <div className="mt-2 flex items-center gap-1">
                        <button
                          onClick={() => mcpAction(window.lmcodeAPI.reconnectMcpServer, srv.name)}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                        >
                          <RefreshCw size={11} /> 重连
                        </button>
                        <button
                          onClick={() => mcpAction(window.lmcodeAPI.stopMcpServer, srv.name)}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                        >
                          <Square size={11} /> 停止
                        </button>
                        <button
                          onClick={() => mcpAction(window.lmcodeAPI.removeMcpServer, srv.name)}
                          disabled={isBusy}
                          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-accent-soft)] hover:text-[var(--lm-error)] disabled:opacity-50"
                        >
                          <Trash2 size={11} /> 移除
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
