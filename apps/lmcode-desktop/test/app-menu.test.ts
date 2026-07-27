import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  createAppMenuTemplate,
  type AppMenuActions,
} from '../src/main/app-menu'
import type { DesktopMenuState } from '../src/shared/menu-types'

const ACTIVE_MENU_STATE: DesktopMenuState = {
  hasActiveSession: true,
  canFindInConversation: true,
  sidebarOpen: true,
  canGoPrevious: true,
  canGoNext: true,
}

function createActions(): AppMenuActions {
  return {
    dispatch: vi.fn(),
    hideWindow: vi.fn(),
    quit: vi.fn(),
    checkForUpdates: vi.fn(),
    showAbout: vi.fn(),
    openDocumentation: vi.fn(),
    openChangelog: vi.fn(),
    reportIssue: vi.fn(),
    openDataDirectory: vi.fn(),
  }
}

function submenuItems(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? item.submenu : []
}

function findMenuItem(
  items: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === label) return item
    const nested = findMenuItem(submenuItems(item), label)
    if (nested) return nested
  }
  return undefined
}

function invoke(item: MenuItemConstructorOptions | undefined): void {
  expect(item?.click).toBeTypeOf('function')
  if (item?.click) Reflect.apply(item.click, undefined, [])
}

describe('desktop application menu', () => {
  it('uses the Codex-style Windows structure and dispatches real product commands', () => {
    const actions = createActions()
    const template = createAppMenuTemplate({
      appName: 'LMCODE',
      isDevelopment: false,
      isMac: false,
      state: ACTIVE_MENU_STATE,
      actions,
    })

    expect(template.map((item) => item.label)).toEqual(['文件', '编辑', '视图', '帮助'])
    expect(findMenuItem(template, '窗口')).toBeUndefined()
    expect(findMenuItem(template, '重新加载窗口')).toBeUndefined()
    expect(findMenuItem(template, '开发者工具')).toBeUndefined()

    invoke(findMenuItem(template, '新建对话'))
    invoke(findMenuItem(template, '打开项目…'))
    invoke(findMenuItem(template, '在当前对话中查找…'))
    invoke(findMenuItem(template, '项目终端'))
    invoke(findMenuItem(template, 'Git 变更'))
    invoke(findMenuItem(template, '命令面板…'))
    invoke(findMenuItem(template, '键盘快捷键'))

    expect(actions.dispatch).toHaveBeenCalledWith('new-conversation')
    expect(actions.dispatch).toHaveBeenCalledWith('open-project')
    expect(actions.dispatch).toHaveBeenCalledWith('find-in-conversation')
    expect(actions.dispatch).toHaveBeenCalledWith('show-terminal')
    expect(actions.dispatch).toHaveBeenCalledWith('show-git-review')
    expect(actions.dispatch).toHaveBeenCalledWith('show-command-palette')
    expect(actions.dispatch).toHaveBeenCalledWith('show-keyboard-shortcuts')

    invoke(findMenuItem(template, '隐藏窗口'))
    invoke(findMenuItem(template, '退出 LMCODE'))
    expect(actions.hideWindow).toHaveBeenCalledTimes(1)
    expect(actions.quit).toHaveBeenCalledTimes(1)
  })

  it('reflects renderer state so unavailable actions cannot be selected', () => {
    const template = createAppMenuTemplate({
      appName: 'LMCODE',
      isDevelopment: false,
      isMac: false,
      state: {
        hasActiveSession: false,
        canFindInConversation: false,
        sidebarOpen: false,
        canGoPrevious: false,
        canGoNext: false,
      },
      actions: createActions(),
    })

    expect(findMenuItem(template, '显示侧栏')).toMatchObject({
      type: 'checkbox',
      checked: false,
    })
    expect(findMenuItem(template, '重命名当前对话…')?.enabled).toBe(false)
    expect(findMenuItem(template, '导出当前对话…')?.enabled).toBe(false)
    expect(findMenuItem(template, '在当前对话中查找…')?.enabled).toBe(false)
    expect(findMenuItem(template, '项目终端')?.enabled).toBe(false)
    expect(findMenuItem(template, '上一个对话')?.enabled).toBe(false)
    expect(findMenuItem(template, '下一个对话')?.enabled).toBe(false)
  })

  it('keeps reload and developer tools inside a development-only submenu', () => {
    const template = createAppMenuTemplate({
      appName: 'LMCODE',
      isDevelopment: true,
      isMac: false,
      state: ACTIVE_MENU_STATE,
      actions: createActions(),
    })

    expect(findMenuItem(template, '开发者')).toBeDefined()
    expect(findMenuItem(template, '重新加载窗口')?.role).toBe('reload')
    expect(findMenuItem(template, '开发者工具')?.role).toBe('toggleDevTools')
  })
})
