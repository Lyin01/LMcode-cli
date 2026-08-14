import type { WebContents } from 'electron'
import type { DesktopMenuCommand } from '../shared/menu-types.js'

export interface MenuCommandTarget {
  isDestroyed(): boolean
  webContents: WebContents
}

/**
 * Delivers menu commands to the renderer, deferring while the main frame is
 * still loading. At most one command waits at a time: a newer command
 * supersedes the pending one, and a failed load drops the pending command
 * instead of replaying it after the next successful load.
 */
export class MenuCommandDispatcher {
  private cancelPending: (() => void) | null = null

  dispatch(target: MenuCommandTarget, command: DesktopMenuCommand): void {
    this.cancelPending?.()
    this.cancelPending = null

    const send = (): void => {
      if (!target.isDestroyed()) {
        target.webContents.send('lmcode:menuCommand', { command })
      }
    }

    const webContents = target.webContents
    if (!webContents.isLoadingMainFrame()) {
      send()
      return
    }

    const cleanup = (): void => {
      webContents.removeListener('did-finish-load', onFinished)
      webContents.removeListener('did-fail-load', onFailed)
      if (this.cancelPending === cleanup) this.cancelPending = null
    }
    const onFinished = (): void => {
      cleanup()
      send()
    }
    const onFailed = (): void => {
      cleanup()
    }
    this.cancelPending = cleanup
    webContents.once('did-finish-load', onFinished)
    webContents.once('did-fail-load', onFailed)
  }
}
