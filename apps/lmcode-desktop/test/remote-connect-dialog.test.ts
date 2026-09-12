import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RemoteConnectBody } from '../src/renderer/components/dialogs/RemoteConnectDialog'
import type { RemoteState } from '../src/shared/remote-types'

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    enabled: true,
    port: 37_991,
    token: 'pair-token',
    lanUrls: ['http://192.168.1.5:37991'],
    clientCount: 1,
    version: '0.0.0-test',
    ...overrides,
  }
}

function render(overrides: Partial<Parameters<typeof RemoteConnectBody>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RemoteConnectBody, {
      state: remoteState(),
      qrUrl: 'data:image/png;base64,AAAA',
      busy: false,
      error: null,
      onEnable: vi.fn(),
      ...overrides,
    }),
  )
}

describe('remote connect dialog body', () => {
  it('offers a single enable action while the service is off', () => {
    const markup = render({ state: remoteState({ enabled: false }), qrUrl: null })
    expect(markup).toContain('开启并显示二维码')
    expect(markup).not.toContain('远程连接二维码')
  })

  it('shows the pairing QR, the LAN link and the token while enabled', () => {
    const markup = render()
    expect(markup).toContain('alt="远程连接二维码"')
    expect(markup).toContain('http://192.168.1.5:37991')
    expect(markup).toContain('pair-token')
    expect(markup).toContain('自动配对')
  })

  it('reports a missing LAN address instead of rendering a broken QR', () => {
    const markup = render({ state: remoteState({ lanUrls: [] }), qrUrl: null })
    expect(markup).toContain('未检测到局域网地址')
    expect(markup).not.toContain('<img')
  })

  it('shows a loading line before the first state arrives', () => {
    const markup = render({ state: null, qrUrl: null })
    expect(markup).toContain('正在读取远程连接状态')
  })

  it('surfaces enable failures', () => {
    const markup = render({
      state: remoteState({ enabled: false }),
      qrUrl: null,
      error: '端口 37991 已被占用',
    })
    expect(markup).toContain('端口 37991 已被占用')
  })
})
