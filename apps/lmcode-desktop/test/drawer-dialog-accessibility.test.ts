import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBrowser } from '@/components/MemoryBrowser'
import { ExtensionsPanel } from '@/components/ExtensionsPanel'

describe('desktop drawer dialog accessibility contract', () => {
  it('memory drawer is a named modal dialog with labelled controls', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryBrowser, { open: true, onClose: vi.fn() }),
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="lm-memory-panel-title"')
    expect(html).toContain('id="lm-memory-panel-title"')
    expect(html).toContain('aria-label="关闭记忆库"')
    expect(html).toContain('title="关闭记忆库"')
    expect(html).toContain('aria-label="搜索记忆"')
    expect(html).toContain('data-lm-autofocus="true"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('extensions drawer is a named modal dialog with a labelled close button', () => {
    const html = renderToStaticMarkup(
      createElement(ExtensionsPanel, { open: true, onClose: vi.fn() }),
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="lm-extensions-panel-title"')
    expect(html).toContain('id="lm-extensions-panel-title"')
    expect(html).toContain('aria-label="关闭扩展"')
    expect(html).toContain('title="关闭扩展"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('closed drawers render nothing', () => {
    expect(
      renderToStaticMarkup(createElement(MemoryBrowser, { open: false, onClose: vi.fn() })),
    ).toBe('')
    expect(
      renderToStaticMarkup(createElement(ExtensionsPanel, { open: false, onClose: vi.fn() })),
    ).toBe('')
  })
})
