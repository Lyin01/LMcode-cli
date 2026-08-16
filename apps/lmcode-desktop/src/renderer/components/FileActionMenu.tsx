import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, ExternalLink, Code2, Copy, Check } from 'lucide-react'

interface MenuState {
  readonly x: number
  readonly y: number
  readonly path: string
}

interface FileActionMenuProps {
  readonly state: MenuState
  readonly onClose: () => void
}

const MENU_ITEMS = [
  { key: 'open', label: '打开（系统默认）', icon: ExternalLink },
  { key: 'reveal', label: '在资源管理器中显示', icon: FolderOpen },
  { key: 'vscode', label: '用 VSCode 打开', icon: Code2 },
  { key: 'copy', label: '复制完整路径', icon: Copy },
] as const

type MenuAction = (typeof MENU_ITEMS)[number]['key']

function fileActionMenuClass(): string {
  return 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]'
}

/**
 * 文件右键菜单：打开 / 资源管理器定位 / VSCode / 复制路径。
 * 通过 useFileContextMenu() 驱动，渲染在 body 下的 fixed 层。
 */
export function FileActionMenu({ state, onClose }: FileActionMenuProps) {
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const runAction = useCallback(
    async (action: MenuAction): Promise<void> => {
      const { path } = state
      onClose()
      try {
        switch (action) {
          case 'open':
            await window.lmcodeAPI.openPath(path)
            break
          case 'reveal':
            await window.lmcodeAPI.showItemInFolder(path)
            break
          case 'vscode':
            await window.lmcodeAPI.openInVscode(path)
            break
          case 'copy':
            await navigator.clipboard.writeText(path)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
            break
        }
      } catch (error) {
        console.error('file action failed:', error)
      }
    },
    [state, onClose],
  )

  // 靠近右/下边缘时向内翻转，避免菜单被窗口裁掉。
  const estimateWidth = 190
  const estimateHeight = MENU_ITEMS.length * 32 + 12
  const left = Math.min(state.x, window.innerWidth - estimateWidth - 8)
  const top = Math.min(state.y, window.innerHeight - estimateHeight - 8)

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left, top }}
      className="fixed z-50 w-48 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] p-1 shadow-[var(--lm-shadow-soft)]"
    >
      <div className="truncate px-2.5 pb-1 pt-0.5 text-[10.5px] text-[var(--lm-text-muted)]" title={state.path}>
        {state.path}
      </div>
      {MENU_ITEMS.map((item) => {
        const Icon = item.key === 'copy' && copied ? Check : item.icon
        return (
          <button key={item.key} type="button" role="menuitem" className={fileActionMenuClass()} onClick={() => void runAction(item.key)}>
            <Icon size={13} className="shrink-0 text-[var(--lm-text-muted)]" />
            <span className="truncate">{item.key === 'copy' && copied ? '已复制' : item.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

/** 在任意元素上启用文件右键菜单：onContextMenu={menu.openFromEvent(path)}。 */
export function useFileContextMenu() {
  const [state, setState] = useState<MenuState | null>(null)
  const openFromEvent = useCallback((path: string) => {
    return (event: React.MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      setState({ x: event.clientX, y: event.clientY, path })
    }
  }, [])
  const close = useCallback(() => setState(null), [])
  const menu = state === null ? null : <FileActionMenu state={state} onClose={close} />
  return { openFromEvent, menu }
}

/** 点击输出文件：系统默认程序打开（HTML 走浏览器、图片走查看器）。 */
export async function openFileWithSystem(path: string): Promise<void> {
  try {
    const error = await window.lmcodeAPI.openPath(path)
    if (error !== undefined && error.length > 0) console.error('openPath failed:', error)
  } catch (error) {
    console.error('openPath failed:', error)
  }
}
