import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { MenuCommandDispatcher } from '../src/main/menu-dispatch'

function createTarget(loading: boolean) {
  const webContents = new EventEmitter() as EventEmitter & {
    isLoadingMainFrame: () => boolean
    send: ReturnType<typeof vi.fn>
  }
  webContents.isLoadingMainFrame = () => loading
  webContents.send = vi.fn()
  const target = {
    isDestroyed: vi.fn(() => false),
    webContents,
  }
  return { target, webContents }
}

describe('MenuCommandDispatcher', () => {
  it('sends immediately when the renderer is not loading', () => {
    const dispatcher = new MenuCommandDispatcher()
    const { target, webContents } = createTarget(false)

    dispatcher.dispatch(target as never, 'show-settings')

    expect(webContents.send).toHaveBeenCalledWith('lmcode:menuCommand', {
      command: 'show-settings',
    })
  })

  it('defers while loading and delivers once did-finish-load fires', () => {
    const dispatcher = new MenuCommandDispatcher()
    const { target, webContents } = createTarget(true)

    dispatcher.dispatch(target as never, 'new-conversation')
    expect(webContents.send).not.toHaveBeenCalled()

    webContents.emit('did-finish-load')
    expect(webContents.send).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('lmcode:menuCommand', {
      command: 'new-conversation',
    })
    // The one-shot dispatch must not fire again on a later load.
    webContents.emit('did-finish-load')
    expect(webContents.send).toHaveBeenCalledTimes(1)
  })

  it('drops the pending command when loading fails instead of replaying it later', () => {
    const dispatcher = new MenuCommandDispatcher()
    const { target, webContents } = createTarget(true)

    dispatcher.dispatch(target as never, 'show-settings')
    webContents.emit('did-fail-load')
    webContents.emit('did-finish-load')

    expect(webContents.send).not.toHaveBeenCalled()
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
  })

  it('supersedes a pending command when a newer one arrives while loading', () => {
    const dispatcher = new MenuCommandDispatcher()
    const { target, webContents } = createTarget(true)

    dispatcher.dispatch(target as never, 'show-settings')
    dispatcher.dispatch(target as never, 'show-automations')

    // Only the latest command waits, with exactly one set of listeners.
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(1)

    webContents.emit('did-finish-load')
    expect(webContents.send).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('lmcode:menuCommand', {
      command: 'show-automations',
    })
  })

  it('does not send to a destroyed window once the deferred load finishes', () => {
    const dispatcher = new MenuCommandDispatcher()
    const { target, webContents } = createTarget(true)

    dispatcher.dispatch(target as never, 'show-settings')
    target.isDestroyed.mockReturnValue(true)
    webContents.emit('did-finish-load')

    expect(webContents.send).not.toHaveBeenCalled()
  })
})
