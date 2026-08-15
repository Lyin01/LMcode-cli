import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'
import { SettingsPanel } from '@/components/SettingsPanel'
import * as configStoreModule from '@/stores/config-store'
import type { ConfigStore } from '@/stores/config-store'
import * as sessionStoreModule from '@/stores/session-store'
import type { SessionStore } from '@/stores/session-store'

const settingsProps = {
  open: true,
  onClose: vi.fn(),
  onOpenExtensions: vi.fn(),
  onOpenKeyboardShortcuts: vi.fn(),
  theme: 'dark' as const,
  onThemeChange: vi.fn(),
}

let sessionState: SessionStore
let configState: ConfigStore

describe('desktop settings workspace accessibility contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionState = {
      ...sessionStoreModule.useSessionStore.getState(),
      currentSessionId: 'session-a',
      model: 'k3',
      thinkingLevel: 'medium',
      permission: 'manual',
    }
    configState = {
      ...configStoreModule.useConfigStore.getState(),
      homeDir: 'C:/Users/owner/.lmcode',
      config: {
        defaultModel: 'k3',
        providers: { kimi: { type: 'anthropic' } },
        models: {
          k3: {
            provider: 'kimi',
            model: 'kimi-k3',
            maxContextSize: 1_000_000,
          },
        },
      } as LmcodeConfig,
    }
    vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(
      ((selector) => selector(sessionState)) as typeof sessionStoreModule.useSessionStore,
    )
    vi.spyOn(configStoreModule, 'useConfigStore').mockImplementation(
      ((selector) => selector(configState)) as typeof configStoreModule.useConfigStore,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a full settings dialog with searchable category navigation', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, settingsProps))

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="搜索设置"')
    expect(html).toContain('aria-label="设置分类"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('返回应用')
    expect(html).toContain('键盘快捷键')
    expect(html).toContain('扩展')
    expect(html).toContain('关于')
  })

  it('keeps the real Agent preference control and current task status visible', () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, settingsProps))

    expect(html).toContain('id="settings-thinking-level"')
    expect(html).toContain('中（推荐）')
    expect(html).toContain('已连接')
    expect(html).toContain('设置变更会立即同步到当前打开的任务')
  })

  it('does not leave hidden settings markup mounted when closed', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPanel, { ...settingsProps, open: false }),
    )

    expect(html).toBe('')
  })
})
