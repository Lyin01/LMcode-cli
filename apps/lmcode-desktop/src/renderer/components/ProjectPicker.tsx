import { useMemo, useState } from 'react'
import { Check, ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher'
import {
  collectProjects,
  isNoProjectWorkDir,
  projectDisplayName,
  truncateProjectPath,
} from '@/lib/projects'

interface ProjectPickerProps {
  /**
   * `path` renders the head-truncated full path (sidebar row);
   * `name` renders only the directory name (composer chip).
   */
  readonly display: 'path' | 'name'
  readonly className?: string
}

/**
 * Project selector button + dropdown. Shared by the sidebar header and the
 * chat composer chip so both surfaces expose identical switching behavior
 * (switch to the project's latest conversation, create one when the project
 * is empty, or pick a new folder through the system dialog).
 */
export function ProjectPicker({ display, className }: ProjectPickerProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const noProjectWorkDir = useSessionStore((s) => s.noProjectWorkDir)
  const rawWorkDir = sessions.find(
    (session) => session.id === currentSessionId,
  )?.workDir
  const isNoProject = isNoProjectWorkDir(rawWorkDir, noProjectWorkDir)
  const currentWorkDir = isNoProject ? undefined : rawWorkDir
  const projects = useMemo(
    () => collectProjects(sessions, noProjectWorkDir),
    [sessions, noProjectWorkDir],
  )
  const { switchProject, openProject } = useProjectSwitcher()
  const [open, setOpen] = useState(false)

  const label = isNoProject
    ? '不在项目中工作'
    : currentWorkDir
      ? display === 'path'
        ? truncateProjectPath(currentWorkDir)
        : projectDisplayName(currentWorkDir)
      : '选择项目'

  const handleSelect = (workDir: string): void => {
    setOpen(false)
    switchProject(workDir)
  }

  const handleOpenFolder = (): void => {
    setOpen(false)
    openProject()
  }

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={currentWorkDir ?? '选择项目'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={currentWorkDir ? `当前项目：${currentWorkDir}` : '选择项目'}
        className={cn(
          'flex items-center gap-2 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]',
          display === 'path' ? 'w-full px-2.5 py-1.5' : 'max-w-56 rounded-full px-3 py-1.5',
        )}
      >
        <Folder size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={() => setOpen(false)}
            aria-label="关闭项目列表"
            tabIndex={-1}
          />
          <div
            role="menu"
            aria-label="项目列表"
            className={cn(
              'absolute z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--lm-border-strong)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-soft)]',
              display === 'path' ? 'left-0 right-0 top-full' : 'left-0 top-full w-72',
            )}
          >
            {projects.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-[var(--lm-text-muted)]">
                暂无最近项目
              </p>
            )}
            {projects.map((project) => (
              <button
                key={project.workDir}
                type="button"
                role="menuitem"
                onClick={() => handleSelect(project.workDir)}
                title={project.workDir}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors',
                  project.workDir === currentWorkDir
                    ? 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]'
                    : 'text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {truncateProjectPath(project.workDir)}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--lm-text-muted)]">
                  {project.sessionCount}
                </span>
                {project.workDir === currentWorkDir && (
                  <Check size={13} className="shrink-0 text-[var(--lm-accent-text)]" />
                )}
              </button>
            ))}
            <div className="my-1 border-t border-[var(--lm-border)]" />
            <button
              type="button"
              role="menuitem"
              onClick={handleOpenFolder}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
            >
              <FolderOpen size={13} className="shrink-0" />
              <span>选择文件夹…</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
