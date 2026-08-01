import { useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Folder, FolderOpen, FolderX } from 'lucide-react'
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
  /** `path` is a sidebar field; `name` is a compact composer control. */
  readonly display: 'path' | 'name'
  readonly className?: string
}

const projectItemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--lm-text-secondary)] outline-none data-[highlighted]:bg-[var(--lm-bg-hover)] data-[highlighted]:text-[var(--lm-text-primary)]'

/** Shared, keyboard-accessible project switcher for sidebar and composer. */
export function ProjectPicker({ display, className }: ProjectPickerProps) {
  const sessions = useSessionStore((state) => state.sessions)
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const noProjectWorkDir = useSessionStore((state) => state.noProjectWorkDir)
  const rawWorkDir = sessions.find(
    (session) => session.id === currentSessionId,
  )?.workDir
  const isNoProject = isNoProjectWorkDir(rawWorkDir, noProjectWorkDir)
  const currentWorkDir = isNoProject ? undefined : rawWorkDir
  const projects = useMemo(
    () => collectProjects(sessions, noProjectWorkDir),
    [noProjectWorkDir, sessions],
  )
  const { switchProject, openProject } = useProjectSwitcher()
  const [open, setOpen] = useState(false)

  const label = isNoProject
    ? '未关联项目'
    : currentWorkDir
      ? display === 'path'
        ? truncateProjectPath(currentWorkDir)
        : projectDisplayName(currentWorkDir)
      : '选择项目'
  const accessibleLabel = isNoProject
    ? '当前任务未关联项目'
    : currentWorkDir
      ? `当前项目：${currentWorkDir}`
      : '选择项目'

  return (
    <div className={className}>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title={currentWorkDir ?? accessibleLabel}
            aria-label={accessibleLabel}
            className={cn(
              'flex items-center gap-2 border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[11px] font-medium text-[var(--lm-text-secondary)] outline-none transition-colors hover:border-[var(--lm-border-strong)] hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--lm-accent)]',
              display === 'path'
                ? 'w-full rounded-lg px-2.5 py-1.5'
                : 'max-w-[160px] rounded-lg border-transparent bg-transparent px-2.5 py-1.5 sm:max-w-56',
            )}
          >
            {isNoProject ? (
              <FolderX size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
            ) : (
              <Folder size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <ChevronDown
              size={12}
              className={cn('shrink-0 text-[var(--lm-text-muted)] transition-transform', open && 'rotate-180')}
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side={display === 'name' ? 'top' : 'bottom'}
            align="start"
            sideOffset={6}
            className={cn(
              'z-50 max-h-72 overflow-y-auto rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-pop)]',
              display === 'path' ? 'w-[var(--radix-dropdown-menu-trigger-width)]' : 'w-72',
            )}
          >
            <DropdownMenu.Label className="px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--lm-text-muted)]">
              最近项目
            </DropdownMenu.Label>
            {projects.length === 0 && (
              <p className="px-2.5 py-3 text-[11px] text-[var(--lm-text-muted)]">
                暂无最近项目
              </p>
            )}
            {projects.map((project) => {
              const selected = project.workDir === currentWorkDir
              return (
                <DropdownMenu.Item
                  key={project.workDir}
                  onSelect={() => switchProject(project.workDir)}
                  title={project.workDir}
                  className={cn(
                    projectItemClass,
                    selected && 'bg-[var(--lm-bg-active)] text-[var(--lm-text-primary)]',
                  )}
                >
                  <Folder size={13} className="shrink-0 text-[var(--lm-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {truncateProjectPath(project.workDir, display === 'path' ? 25 : 34)}
                  </span>
                  <span className="shrink-0 text-[9px] text-[var(--lm-text-muted)]">
                    {project.sessionCount}
                  </span>
                  {selected && (
                    <Check size={13} className="shrink-0 text-[var(--lm-accent-text)]" />
                  )}
                </DropdownMenu.Item>
              )
            })}
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--lm-border)]" />
            <DropdownMenu.Item onSelect={openProject} className={projectItemClass}>
              <FolderOpen size={13} />
              选择文件夹…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}
