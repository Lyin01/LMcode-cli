import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FlaskConical,
  FolderOpen,
  History,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { activateModalPanel } from '@/lib/modal-panel-controller'
import type { PurgeSkill, PurgeStatus } from '../../shared/purge-types'

interface PurgePanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

type Tab = 'clean' | 'rules' | 'skills'

const TABS: readonly (readonly [Tab, string, typeof Wand2])[] = [
  ['clean', '清洗', Wand2],
  ['rules', '规则集', ListChecks],
  ['skills', '技能', Zap],
]

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}

export function PurgePanel({ open, onClose }: PurgePanelProps) {
  const [tab, setTab] = useState<Tab>('clean')
  const [status, setStatus] = useState<PurgeStatus | null>(null)
  const [skills, setSkills] = useState<readonly PurgeSkill[]>([])
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newRuleId, setNewRuleId] = useState('')
  const [newRuleBody, setNewRuleBody] = useState('')
  const [showNewRule, setShowNewRule] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // The draft must survive a refresh that happens for an unrelated reason
  // (opening the panel, applying a rule) while the user is still typing.
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const refresh = useCallback(async (force = false): Promise<void> => {
    const next = await window.lmcodeAPI.purgeStatus()
    setStatus(next)
    // force：以磁盘为准。面板重新打开或用户点刷新时必须走这条，
    // 否则会拿着一份关面板前留下的旧草稿去覆盖刚改过的 prompt.md。
    if (force || !dirtyRef.current) {
      setDraft(next.promptText)
      setDirty(false)
    }
    setSkills(await window.lmcodeAPI.purgeListSkills())
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const discarded = dirtyRef.current
    setError(null)
    setNotice(discarded ? '已重新载入磁盘内容，上次未保存的草稿已丢弃。' : null)
    void refresh(true).catch((err: unknown) => {
      if (!cancelled) setError(errorMessage(err, '无法读取 Purge 状态'))
    })
    return () => {
      cancelled = true
    }
  }, [open, refresh])

  useEffect(() => {
    if (!open || !panelRef.current) return
    return activateModalPanel(panelRef.current, { onClose: () => onCloseRef.current() })
  }, [open])

  const run = useCallback(
    async (label: string, action: () => Promise<void>, done?: string): Promise<void> => {
      setBusy(label)
      setError(null)
      setNotice(null)
      try {
        await action()
        if (done !== undefined) setNotice(done)
      } catch (err) {
        setError(errorMessage(err, '操作失败'))
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const savePrompt = async (): Promise<PurgeStatus> => {
    const next = await window.lmcodeAPI.purgeSavePrompt(draft)
    setStatus(next)
    setDirty(false)
    return next
  }

  const handleSavePrompt = () =>
    run('save', async () => {
      await savePrompt()
      setNotice('草稿已保存。点「应用」才会写进 AGENTS.md。')
    })

  const handleApply = () =>
    run(
      'apply',
      async () => {
        if (dirty) await savePrompt()
        const result = await window.lmcodeAPI.purgeApply()
        setStatus(result.status)
        setNotice(result.message)
      },
    )

  const handleRevert = (restore: boolean) =>
    run(restore ? 'restore' : 'revert', async () => {
      const result = await window.lmcodeAPI.purgeRevert(restore)
      setStatus(result.status)
      setDirty(false)
      setDraft(result.status.promptText)
      setNotice(result.message)
    })

  const handleToggleRule = (id: string, enabled: boolean) =>
    run(`rule:${id}`, async () => {
      setStatus(await window.lmcodeAPI.purgeSetRuleEnabled(id, enabled))
    })

  const handleDeleteRule = (id: string) =>
    run(`rule-del:${id}`, async () => {
      setStatus(await window.lmcodeAPI.purgeDeleteRule(id))
      setNotice(`已删除规则 ${id}`)
    })

  const handleSaveRule = () =>
    run('rule-save', async () => {
      const next = await window.lmcodeAPI.purgeSaveRule(newRuleId.trim(), newRuleBody)
      setStatus(next)
      setNewRuleId('')
      setNewRuleBody('')
      setShowNewRule(false)
      setNotice('规则已保存。启用后点「应用」生效。')
    })

  const handleImportSkill = () =>
    run('skill-import', async () => {
      const next = await window.lmcodeAPI.purgeImportSkill()
      if (next === undefined) return
      setStatus(next)
      setSkills(await window.lmcodeAPI.purgeListSkills())
      setNotice('技能已导入。新会话即可加载。')
    })

  const handleDeleteSkill = (id: string) =>
    run(`skill-del:${id}`, async () => {
      setStatus(await window.lmcodeAPI.purgeDeleteSkill(id))
      setSkills(await window.lmcodeAPI.purgeListSkills())
      setNotice(`已删除技能 ${id}`)
    })

  if (!open) return null

  const pending = status === null ? false : dirty || status.drift
  const blockLabel = status === null
    ? '读取中…'
    : status.empty
      ? '无内容可注入'
      : status.drift
        ? '有改动未应用'
        : status.blockPresent
          ? '已应用'
          : '未应用'

  return (
    <div className="fixed inset-x-0 top-0 bottom-[var(--lm-global-usage-height)] z-40 flex">
      <div aria-hidden="true" className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-purge-panel-title"
        className="relative z-10 ml-auto flex h-full w-[560px] max-w-[94vw] flex-col border-l border-[var(--lm-border)] bg-[var(--lm-bg-base)] shadow-[var(--lm-shadow-pop)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--lm-border)] px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <FlaskConical size={16} className="shrink-0 text-[var(--lm-accent-text)]" />
            <div className="min-w-0">
              <h2
                id="lm-purge-panel-title"
                className="truncate text-[15px] font-semibold text-[var(--lm-text-primary)]"
              >
                LMD Purge
              </h2>
              <p className="truncate text-[10.5px] text-[var(--lm-text-muted)]">
                会话覆盖段 · 规则集 · 技能（dsh-purge 适配版）
              </p>
            </div>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                status?.drift || dirty
                  ? 'bg-[var(--lm-warning)]/15 text-[var(--lm-warning)]'
                  : status?.blockPresent
                    ? 'bg-[var(--lm-success)]/15 text-[var(--lm-success)]'
                    : 'bg-[var(--lm-bg-hover)] text-[var(--lm-text-muted)]',
              )}
            >
              {blockLabel}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="刷新状态"
              title="刷新状态"
              onClick={() => void run('refresh', async () => refresh(true))}
              className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            >
              <RefreshCw size={15} className={busy === 'refresh' ? 'animate-spin' : undefined} />
            </button>
            <button
              type="button"
              aria-label="关闭 Purge"
              title="关闭 Purge"
              data-lm-autofocus="true"
              onClick={onClose}
              className="rounded-md p-1.5 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[var(--lm-border)] px-3 pt-2">
          {TABS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
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
        </div>

        {/* Feedback */}
        {(error !== null || notice !== null) && (
          <div
            className={cn(
              'mx-4 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]',
              error !== null
                ? 'border-[var(--lm-error)]/40 bg-[var(--lm-error)]/10 text-[var(--lm-error)]'
                : 'border-[var(--lm-success)]/40 bg-[var(--lm-success)]/10 text-[var(--lm-success)]',
            )}
          >
            {error !== null ? (
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-words">{error ?? notice}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === 'clean' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
                <div className="flex items-center gap-2 text-[12px] text-[var(--lm-text-secondary)]">
                  <FileText size={13} className="text-[var(--lm-accent-text)]" />
                  <span className="truncate" title={status?.target ?? ''}>
                    注入目标：{status?.target ?? '…'}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--lm-text-muted)]">
                  <span>覆盖段：{status?.blockPresent ? `${status.blockBytes} 字节` : '无'}</span>
                  <span>规则：{status?.enabledRules.length ?? 0} 条启用</span>
                  <span>备份：{status?.backups.length ?? 0} 份</span>
                  <span>最近应用：{status?.appliedAt ? new Date(status.appliedAt).toLocaleString() : '从未'}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void run('reveal', async () => window.lmcodeAPI.purgeReveal())}
                    className="flex items-center gap-1 rounded-md border border-[var(--lm-border)] px-2 py-1 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)]"
                  >
                    <FolderOpen size={12} />
                    打开所在目录
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label
                    htmlFor="lm-purge-prompt"
                    className="text-[12px] font-medium text-[var(--lm-text-secondary)]"
                  >
                    会话覆盖段正文
                  </label>
                  <span className="text-[10.5px] text-[var(--lm-text-muted)]">
                    {draft.length} 字符{dirty ? ' · 未保存' : ''}
                  </span>
                </div>
                <textarea
                  id="lm-purge-prompt"
                  value={draft}
                  spellCheck={false}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setDirty(true)
                  }}
                  placeholder="这里写你要注入到每个新会话的内容。留空（或只留注释）则不会注入任何东西。"
                  className="h-56 w-full resize-y rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3 font-mono text-[12px] leading-relaxed text-[var(--lm-text-primary)] outline-none focus:border-[var(--lm-accent)]"
                />
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--lm-text-muted)]">
                  HTML 注释不计入正文。保存只改草稿，点「应用」才写进 AGENTS.md；LMcode 每个新会话重新读取该文件，不需要重启。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleApply()}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-bg-base)] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy === 'apply' ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                  应用
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !dirty}
                  onClick={() => void handleSavePrompt()}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--lm-border)] px-3 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                >
                  {busy === 'save' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  保存草稿
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !status?.blockPresent}
                  onClick={() => void handleRevert(false)}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--lm-border)] px-3 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                >
                  {busy === 'revert' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  移除覆盖段
                </button>
                <button
                  type="button"
                  disabled={busy !== null || (status?.backups.length ?? 0) === 0}
                  onClick={() => void handleRevert(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--lm-border)] px-3 py-1.5 text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                >
                  {busy === 'restore' ? <Loader2 size={13} className="animate-spin" /> : <History size={13} />}
                  用备份还原
                </button>
                {pending && (
                  <span className="text-[10.5px] text-[var(--lm-warning)]">有改动未应用</span>
                )}
              </div>
            </div>
          )}

          {tab === 'rules' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-[var(--lm-text-muted)]">
                  规则会按顺序拼在提示词后面。启用后仍需点「应用」。
                </p>
                <button
                  type="button"
                  onClick={() => setShowNewRule((value) => !value)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--lm-border)] px-2 py-1 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)]"
                >
                  <Plus size={12} />
                  新建规则
                </button>
              </div>

              {showNewRule && (
                <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-3">
                  <input
                    value={newRuleId}
                    onChange={(event) => setNewRuleId(event.target.value)}
                    placeholder="规则 id（字母/数字/._-）"
                    spellCheck={false}
                    className="w-full rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-base)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--lm-text-primary)] outline-none focus:border-[var(--lm-accent)]"
                  />
                  <textarea
                    value={newRuleBody}
                    onChange={(event) => setNewRuleBody(event.target.value)}
                    placeholder="规则正文（Markdown）"
                    spellCheck={false}
                    className="mt-2 h-32 w-full resize-y rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-2.5 font-mono text-[12px] text-[var(--lm-text-primary)] outline-none focus:border-[var(--lm-accent)]"
                  />
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      disabled={busy !== null || newRuleId.trim() === '' || newRuleBody.trim() === ''}
                      onClick={() => void handleSaveRule()}
                      className="flex items-center gap-1.5 rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-bg-base)] disabled:opacity-50"
                    >
                      {busy === 'rule-save' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                      保存规则
                    </button>
                  </div>
                </div>
              )}

              {(status?.rules.length ?? 0) === 0 ? (
                <p className="rounded-xl border border-dashed border-[var(--lm-border)] px-3 py-6 text-center text-[12px] text-[var(--lm-text-muted)]">
                  还没有规则。新建一套，或把现有 AGENTS.md 片段粘进来。
                </p>
              ) : (
                <ul className="space-y-2">
                  {status?.rules.map((rule) => (
                    <li
                      key={rule.id}
                      className="flex items-center gap-2.5 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-2.5"
                    >
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={busy !== null}
                        onChange={(event) => void handleToggleRule(rule.id, event.target.checked)}
                        aria-label={`启用规则 ${rule.id}`}
                        className="h-3.5 w-3.5 accent-[var(--lm-accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--lm-text-primary)]">
                        {rule.id}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-[var(--lm-text-muted)]">
                        {rule.bytes} 字节
                      </span>
                      <button
                        type="button"
                        aria-label={`删除规则 ${rule.id}`}
                        title="删除规则"
                        disabled={busy !== null}
                        onClick={() => void handleDeleteRule(rule.id)}
                        className="shrink-0 rounded p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)] disabled:opacity-50"
                      >
                        {busy === `rule-del:${rule.id}` ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'skills' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--lm-text-muted)]" title={status?.skillsRoot ?? ''}>
                  {status?.skillsRoot ?? '~/.agents/skills'}
                </p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleImportSkill()}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--lm-border)] px-2 py-1 text-[11px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:opacity-50"
                >
                  {busy === 'skill-import' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <FolderOpen size={12} />
                  )}
                  导入文件夹
                </button>
              </div>

              {skills.length === 0 ? (
                <p className="rounded-xl border border-dashed border-[var(--lm-border)] px-3 py-6 text-center text-[12px] text-[var(--lm-text-muted)]">
                  用户技能目录为空。导入一个含 SKILL.md 的文件夹。
                </p>
              ) : (
                <ul className="space-y-2">
                  {skills.map((skill) => (
                    <li
                      key={skill.id}
                      className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <Zap size={13} className="shrink-0 text-[var(--lm-accent-text)]" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--lm-text-primary)]">
                          {skill.name}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-[var(--lm-text-muted)]">
                          {skill.id}
                        </span>
                        <button
                          type="button"
                          aria-label={`删除技能 ${skill.id}`}
                          title="删除技能"
                          disabled={busy !== null}
                          onClick={() => void handleDeleteSkill(skill.id)}
                          className="shrink-0 rounded p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-error)] disabled:opacity-50"
                        >
                          {busy === `skill-del:${skill.id}` ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Trash2 size={13} />
                          )}
                        </button>
                      </div>
                      {skill.description !== '' && (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--lm-text-muted)]">
                          {skill.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--lm-border)] px-4 py-2">
          <p className="text-[10px] leading-relaxed text-[var(--lm-text-muted)]">
            只维护 AGENTS.md 的标记段与 ~/.lmcode/purge。不改审批、沙箱与工具权限。
          </p>
        </div>
      </div>
    </div>
  )
}
