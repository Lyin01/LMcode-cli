import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopMenuCommand, DesktopMenuState } from '../shared/menu-types.js'

export interface AppMenuActions {
  readonly dispatch: (command: DesktopMenuCommand) => void
  readonly hideWindow: () => void
  readonly quit: () => void
  readonly checkForUpdates: () => void
  readonly showAbout: () => void
  readonly openDocumentation: () => void
  readonly openChangelog: () => void
  readonly reportIssue: () => void
  readonly openDataDirectory: () => void
}

export interface AppMenuOptions {
  readonly appName: string
  readonly isDevelopment: boolean
  readonly isMac: boolean
  readonly state: DesktopMenuState
  readonly actions: AppMenuActions
}

function commandItem(
  actions: AppMenuActions,
  command: DesktopMenuCommand,
  options: Omit<MenuItemConstructorOptions, 'click'>,
): MenuItemConstructorOptions {
  return {
    ...options,
    click: () => actions.dispatch(command),
  }
}

export function createAppMenuTemplate({
  appName,
  isDevelopment,
  isMac,
  state,
  actions,
}: AppMenuOptions): MenuItemConstructorOptions[] {
  const sessionItem = (
    command: DesktopMenuCommand,
    options: Omit<MenuItemConstructorOptions, 'click' | 'enabled'>,
  ): MenuItemConstructorOptions =>
    commandItem(actions, command, { ...options, enabled: state.hasActiveSession })

  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: [
      commandItem(actions, 'new-conversation', {
        label: '新建对话',
        accelerator: 'CmdOrCtrl+N',
      }),
      commandItem(actions, 'open-project', {
        label: '打开项目…',
        accelerator: 'CmdOrCtrl+O',
      }),
      { type: 'separator' },
      sessionItem('rename-conversation', {
        label: '重命名当前对话…',
        accelerator: 'F2',
      }),
      sessionItem('export-conversation', {
        label: '导出当前对话…',
        accelerator: 'CmdOrCtrl+Shift+E',
      }),
      { type: 'separator' },
      commandItem(actions, 'show-settings', {
        label: '设置…',
        accelerator: 'CmdOrCtrl+,',
      }),
      { type: 'separator' },
      {
        label: isMac ? '关闭窗口' : '隐藏窗口',
        accelerator: 'CmdOrCtrl+W',
        click: actions.hideWindow,
      },
      ...(!isMac
        ? [
            { type: 'separator' as const },
            {
              label: '退出 LMCODE',
              accelerator: 'Ctrl+Q',
              click: actions.quit,
            },
          ]
        : []),
    ],
  }

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '粘贴并匹配样式', role: 'pasteAndMatchStyle' },
      { label: '全选', role: 'selectAll' },
      { type: 'separator' },
      commandItem(actions, 'find-in-conversation', {
        label: '在当前对话中查找…',
        accelerator: 'CmdOrCtrl+F',
        enabled: state.canFindInConversation,
      }),
      commandItem(actions, 'find-next', {
        label: '查找下一个',
        accelerator: isMac ? 'Command+G' : 'Ctrl+G',
        enabled: state.canFindInConversation,
        visible: false,
        acceleratorWorksWhenHidden: true,
      }),
      commandItem(actions, 'find-previous', {
        label: '查找上一个',
        accelerator: isMac ? 'Command+Shift+G' : 'Shift+F3',
        enabled: state.canFindInConversation,
        visible: false,
        acceleratorWorksWhenHidden: true,
      }),
      commandItem(actions, 'search-conversations', {
        label: '搜索对话…',
        accelerator: 'CmdOrCtrl+K',
      }),
      sessionItem('show-command-palette', {
        label: '命令面板…',
        accelerator: 'CmdOrCtrl+Shift+P',
      }),
    ],
  }

  const viewMenuItems: MenuItemConstructorOptions[] = [
    commandItem(actions, 'toggle-sidebar', {
      label: '显示侧栏',
      accelerator: 'CmdOrCtrl+B',
      type: 'checkbox',
      checked: state.sidebarOpen,
    }),
    { type: 'separator' },
    sessionItem('show-git-review', {
      label: 'Git 变更',
      accelerator: 'CmdOrCtrl+Shift+G',
    }),
    sessionItem('show-terminal', {
      label: '项目终端',
      accelerator: 'CmdOrCtrl+J',
    }),
    sessionItem('show-worktrees', { label: 'Git 工作树' }),
    sessionItem('show-subagents', { label: '子 Agent' }),
    commandItem(actions, 'show-tasks', { label: '后台任务' }),
    sessionItem('show-automations', { label: '自动化' }),
    { type: 'separator' },
    sessionItem('show-extensions', { label: '扩展（技能 / MCP）' }),
    commandItem(actions, 'show-memory', { label: '记忆库' }),
    commandItem(actions, 'toggle-theme', { label: '切换亮色 / 暗色主题' }),
    { type: 'separator' },
    commandItem(actions, 'previous-conversation', {
      label: '上一个对话',
      accelerator: 'CmdOrCtrl+PageUp',
      enabled: state.canGoPrevious,
    }),
    commandItem(actions, 'next-conversation', {
      label: '下一个对话',
      accelerator: 'CmdOrCtrl+PageDown',
      enabled: state.canGoNext,
    }),
    { type: 'separator' },
    { label: '放大', role: 'zoomIn' },
    { label: '缩小', role: 'zoomOut' },
    { label: '实际大小', role: 'resetZoom' },
  ]

  if (isDevelopment) {
    viewMenuItems.push(
      { type: 'separator' },
      {
        label: '开发者',
        submenu: [
          { label: '重新加载窗口', role: 'reload' },
          { label: '强制重新加载窗口', role: 'forceReload' },
          { label: '开发者工具', role: 'toggleDevTools' },
        ],
      },
    )
  }

  viewMenuItems.push(
    { type: 'separator' },
    { label: '全屏', role: 'togglefullscreen', accelerator: isMac ? undefined : 'F11' },
  )

  const helpMenu: MenuItemConstructorOptions = {
    label: '帮助',
    submenu: [
      commandItem(actions, 'show-keyboard-shortcuts', {
        label: '键盘快捷键',
        accelerator: 'CmdOrCtrl+/',
      }),
      { type: 'separator' },
      { label: '使用文档', click: actions.openDocumentation },
      { label: '更新日志', click: actions.openChangelog },
      { label: '报告问题', click: actions.reportIssue },
      { type: 'separator' },
      { label: '检查更新…', click: actions.checkForUpdates },
      { label: '打开数据目录', click: actions.openDataDirectory },
      ...(!isMac
        ? [
            { type: 'separator' as const },
            { label: '关于 LMCODE', click: actions.showAbout },
          ]
        : []),
    ],
  }

  return [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { label: '关于 LMCODE', click: actions.showAbout },
              { label: '检查更新…', click: actions.checkForUpdates },
              { type: 'separator' as const },
              commandItem(actions, 'show-settings', {
                label: '设置…',
                accelerator: 'Command+,',
              }),
              { type: 'separator' as const },
              { label: '隐藏 LMCODE', role: 'hide' as const },
              { label: '隐藏其他窗口', role: 'hideOthers' as const },
              { label: '全部显示', role: 'unhide' as const },
              { type: 'separator' as const },
              { label: '退出 LMCODE', role: 'quit' as const },
            ],
          },
        ]
      : []),
    fileMenu,
    editMenu,
    { label: '视图', submenu: viewMenuItems },
    ...(isMac
      ? [
          {
            label: '窗口',
            submenu: [
              { label: '最小化', role: 'minimize' as const },
              { label: '缩放', role: 'zoom' as const },
              { type: 'separator' as const },
              { label: '前置全部窗口', role: 'front' as const },
            ],
          },
        ]
      : []),
    helpMenu,
  ]
}
