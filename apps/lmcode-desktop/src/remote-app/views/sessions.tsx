import { useMemo, useState } from 'react'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'
import { basename, relativeTime } from '../format'

export interface CreateSessionParams {
  readonly workDir?: string
  readonly noProject?: boolean
}

export interface SessionsViewProps {
  readonly sessions: readonly SessionSummary[]
  readonly projects: readonly string[]
  readonly noProjectWorkDir: string | null
  readonly busy: boolean
  readonly onOpen: (id: string) => void
  readonly onRefresh: () => void
  readonly onCreate: (params: CreateSessionParams) => void
}

export interface SessionGroup {
  readonly key: string
  readonly label: string
  readonly sessions: readonly SessionSummary[]
}

/**
 * Group sessions by project for the phone list: "无项目" first-class, groups
 * ordered by latest activity, sessions newest-first inside a group.
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  noProjectWorkDir: string | null,
): SessionGroup[] {
  const noProjectKey = noProjectWorkDir === null ? null : comparableWorkDir(noProjectWorkDir)
  const groups = new Map<string, { label: string; sessions: SessionSummary[]; latest: number }>()
  for (const session of sessions) {
    if (session.archived === true) continue
    const workDir = session.workDir ?? ''
    const comparable = comparableWorkDir(workDir)
    const isNoProject = noProjectKey !== null && comparable === noProjectKey
    const key = isNoProject ? '__no_project__' : comparable.length > 0 ? comparable : '__unknown__'
    const label = isNoProject ? '无项目' : basename(workDir) || '未知项目'
    const activity = session.updatedAt || session.createdAt || 0
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { label, sessions: [session], latest: activity })
    } else {
      existing.sessions.push(session)
      existing.latest = Math.max(existing.latest, activity)
    }
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].latest - left[1].latest)
    .map(([key, group]) => ({
      key,
      label: group.label,
      sessions: [...group.sessions].sort(
        (left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0),
      ),
    }))
}

export function SessionsView({
  sessions,
  projects,
  noProjectWorkDir,
  busy,
  onOpen,
  onRefresh,
  onCreate,
}: SessionsViewProps) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const activeCount = sessions.filter((session) => session.archived !== true).length

  const groups = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const visible =
      terms.length === 0
        ? sessions
        : sessions.filter((session) => {
            const haystack = `${session.title ?? ''}\n${session.lastPrompt ?? ''}\n${session.workDir ?? ''}`
              .toLocaleLowerCase()
            return terms.every((term) => haystack.includes(term))
          })
    return groupSessions(visible, noProjectWorkDir)
  }, [sessions, noProjectWorkDir, query])

  return (
    <div className="rm-sessions">
      <header className="rm-header">
        <div className="rm-header-copy">
          <div className="rm-header-title">会话</div>
          <div className="rm-header-sub">{activeCount} 个会话</div>
        </div>
        <button className="rm-ghost" type="button" onClick={onRefresh} disabled={busy}>
          刷新
        </button>
      </header>

      <div className="rm-sessions-body">
        {creating ? (
          <div className="rm-create">
            <div className="rm-create-title">选择项目</div>
            <button
              className="rm-list-item"
              type="button"
              disabled={busy}
              onClick={() => {
                setCreating(false)
                onCreate({ noProject: true })
              }}
            >
              <span className="rm-list-title">无项目</span>
              <span className="rm-list-sub">不绑定目录，适合临时提问</span>
            </button>
            {projects.map((project) => (
              <button
                key={project}
                className="rm-list-item"
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreating(false)
                  onCreate({ workDir: project })
                }}
              >
                <span className="rm-list-title">{basename(project)}</span>
                <span className="rm-list-sub">{project}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <p className="rm-muted">电脑上还没有项目目录，先在桌面端打开一个项目。</p>
            )}
            <button className="rm-link" type="button" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        ) : (
          <>
            <div className="rm-actions">
              <input
                className="rm-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会话"
                enterKeyHint="search"
              />
              <button className="rm-primary" type="button" disabled={busy} onClick={() => setCreating(true)}>
                新建
              </button>
            </div>

            {groups.length === 0 && (
              <p className="rm-muted rm-empty">
                {sessions.length === 0 ? '还没有会话，点「新建」开始。' : '没有匹配的会话。'}
              </p>
            )}

            {groups.map((group) => (
              <section key={group.key} className="rm-group">
                <div className="rm-group-title">{group.label}</div>
                {group.sessions.map((session) => (
                  <button
                    key={session.id}
                    className="rm-list-item"
                    type="button"
                    disabled={busy}
                    onClick={() => onOpen(session.id)}
                  >
                    <span className="rm-list-title">
                      {session.title?.trim() || '新任务'}
                    </span>
                    <span className="rm-list-sub">
                      {relativeTime(session.updatedAt || session.createdAt || 0)}
                      {session.lastPrompt?.trim() ? ` · ${session.lastPrompt.trim().slice(0, 60)}` : ''}
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function comparableWorkDir(workDir: string): string {
  const normalized = workDir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}
