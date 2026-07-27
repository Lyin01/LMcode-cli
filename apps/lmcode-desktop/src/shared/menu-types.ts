export const DESKTOP_MENU_COMMANDS = [
  'new-conversation',
  'open-project',
  'rename-conversation',
  'export-conversation',
  'show-settings',
  'find-in-conversation',
  'find-next',
  'find-previous',
  'search-conversations',
  'show-command-palette',
  'toggle-sidebar',
  'show-git-review',
  'show-terminal',
  'show-worktrees',
  'show-subagents',
  'show-tasks',
  'show-automations',
  'show-extensions',
  'show-memory',
  'previous-conversation',
  'next-conversation',
  'toggle-theme',
  'show-keyboard-shortcuts',
] as const

export type DesktopMenuCommand = (typeof DESKTOP_MENU_COMMANDS)[number]

export interface DesktopMenuCommandPayload {
  readonly command: DesktopMenuCommand
}

export interface DesktopMenuState {
  readonly hasActiveSession: boolean
  readonly canFindInConversation: boolean
  readonly sidebarOpen: boolean
  readonly canGoPrevious: boolean
  readonly canGoNext: boolean
}

export const DEFAULT_DESKTOP_MENU_STATE: DesktopMenuState = {
  hasActiveSession: false,
  canFindInConversation: false,
  sidebarOpen: true,
  canGoPrevious: false,
  canGoNext: false,
}

export function isDesktopMenuState(value: unknown): value is DesktopMenuState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hasActiveSession' in value &&
    typeof value.hasActiveSession === 'boolean' &&
    'canFindInConversation' in value &&
    typeof value.canFindInConversation === 'boolean' &&
    'sidebarOpen' in value &&
    typeof value.sidebarOpen === 'boolean' &&
    'canGoPrevious' in value &&
    typeof value.canGoPrevious === 'boolean' &&
    'canGoNext' in value &&
    typeof value.canGoNext === 'boolean'
  )
}
