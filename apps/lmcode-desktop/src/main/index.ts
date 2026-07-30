import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron'
import type { IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import updaterPkg from 'electron-updater'
import { LmcodeHarness } from '@lmcode-cli/lmcode-sdk'
import type { HarnessCloseOptions } from '@lmcode-cli/lmcode-sdk'
import { registerAllHandlers, type DesktopHandlerRegistration } from './ipc/handler.js'
import { onceAsync, ShutdownCoordinator, withTimeoutBudget } from './lifecycle.js'
import { createAppMenuTemplate } from './app-menu.js'
import { classifyNavigation, isTrustedIpcSender } from './security.js'
import {
  DEFAULT_DESKTOP_MENU_STATE,
  isDesktopMenuState,
  type DesktopMenuCommand,
  type DesktopMenuState,
} from '../shared/menu-types.js'

// electron-updater is CommonJS; destructure the default export for ESM.
const { autoUpdater } = updaterPkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

let mainWindow: BrowserWindow | null = null
let harness: LmcodeHarness | null = null
let tray: Tray | null = null
let isQuitting = false
let trustedRendererUrl: string | null = null
let handlerRegistration: DesktopHandlerRegistration | null = null
let handlerCleanup: Promise<void> | null = null
let harnessInitialization: Promise<void> | null = null
let desktopMenuState: DesktopMenuState = DEFAULT_DESKTOP_MENU_STATE
let menuStateListener: ((event: IpcMainEvent, state: unknown) => void) | null = null

// ── Shutdown budget ────────────────────────────────────────────────────
//
// The desktop quits with exit-time memory extraction disabled (that LLM
// round-trip was observed at ~11s per session, capped at 30s) — memories are
// still preserved by compaction-time and idle extraction. Cleanup remaining
// (session/terminal teardown, logger flush) is local and fast, but stays
// best-effort with a hard budget, and a watchdog force-exits if anything
// still hangs.
const RUNTIME_CLOSE_BUDGET_MS = 3_000
const SHUTDOWN_WATCHDOG_MS = 6_000
let shutdownWatchdog: NodeJS.Timeout | null = null

function armShutdownWatchdog(): void {
  if (shutdownWatchdog !== null) return
  shutdownWatchdog = setTimeout(() => {
    console.warn('[shutdown] cleanup exceeded the watchdog limit; forcing exit')
    app.exit(0)
  }, SHUTDOWN_WATCHDOG_MS)
  // Never let the watchdog itself keep the process alive.
  shutdownWatchdog.unref()
}

// ── Tray icon ─────────────────────────────────────────────────────────

function createTrayIcon(): Electron.NativeImage {
  // out/main/index.js → out/resources/tray-icon.png (copied by scripts/build.mjs).
  const iconPath = join(__dirname, '../resources/tray-icon.png')
  const img = nativeImage.createFromPath(iconPath)
  if (img.isEmpty()) {
    console.warn(`[tray] icon asset missing or unreadable: ${iconPath}`)
    return nativeImage.createEmpty()
  }
  return img.resize({ width: 16, height: 16 })
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('LMCODE')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示 LMCODE',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    {
      label: '新建会话',
      click: () => dispatchMenuCommand('new-conversation'),
    },
    {
      label: '自动化',
      click: () => dispatchMenuCommand('show-automations'),
    },
    {
      label: '设置',
      click: () => dispatchMenuCommand('show-settings'),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // Click tray icon → toggle window visibility
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
}

// ── Global shortcuts ──────────────────────────────────────────────────

function registerShortcuts(): void {
  // CmdOrCtrl+Shift+L → 显示/聚焦窗口
  globalShortcut.register('CmdOrCtrl+Shift+L', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // CmdOrCtrl+Shift+M → 最小化窗口
  globalShortcut.register('CmdOrCtrl+Shift+M', () => {
    mainWindow?.minimize()
  })
}

// ── Application menu (localized) ────────────────────────────────────────

const SOURCE_GITHUB_REPO = 'Lyin01/LMcode-cli'
const SOURCE_GITHUB_URL = `https://github.com/${SOURCE_GITHUB_REPO}`
const DESKTOP_RELEASES_URL = 'https://github.com/Lyin01/LMcode-desktop/releases'

function showAndFocus(): void {
  mainWindow?.show()
  mainWindow?.focus()
}

function messageBox(
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
}

function dispatchMenuCommand(command: DesktopMenuCommand): void {
  showAndFocus()
  const targetWindow = mainWindow
  if (targetWindow === null || targetWindow.isDestroyed()) return

  const send = (): void => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send('lmcode:menuCommand', { command })
    }
  }

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

// Whether the in-flight update check was user-initiated (so we know whether to
// pop a "已是最新" / error dialog vs. staying silent on a background check).
let manualUpdateCheck = false
let updaterWired = false

/**
 * Register electron-updater event handlers once. The feed (GitHub Releases of the
 * dedicated `lmcode-desktop` repo) is baked into app-update.yml from the publish
 * config, so `pnpm run release` uploads installer + latest.yml and this checks /
 * downloads / installs against it.
 */
function setupAutoUpdater(): void {
  if (updaterWired) return
  updaterWired = true

  autoUpdater.autoDownload = false // ask the user before pulling the package
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    const { response } = await messageBox({
      type: 'info',
      title: '检测更新',
      message: `发现新版本 v${info.version}`,
      detail: '是否现在下载？下载完成后可一键重启安装。',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((e) => {
        void messageBox({ type: 'error', title: '检测更新', message: '下载更新失败', detail: String(e), buttons: ['确定'] })
      })
    }
  })

  autoUpdater.on('update-not-available', () => {
    if (manualUpdateCheck) {
      void messageBox({
        type: 'info',
        title: '检测更新',
        message: '已是最新版本',
        detail: `当前版本 v${app.getVersion()}`,
        buttons: ['确定'],
      })
    }
  })

  autoUpdater.on('download-progress', (p) => {
    mainWindow?.setProgressBar(Math.min(Math.max(p.percent / 100, 0), 1))
  })

  autoUpdater.on('update-downloaded', async (info) => {
    mainWindow?.setProgressBar(-1)
    const { response } = await messageBox({
      type: 'info',
      title: '更新就绪',
      message: `v${info.version} 已下载完成`,
      detail: '立即重启并安装更新？',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      isQuitting = true
      autoUpdater.quitAndInstall()
    }
  })

  autoUpdater.on('error', (err) => {
    mainWindow?.setProgressBar(-1)
    if (manualUpdateCheck) {
      void messageBox({
        type: 'error',
        title: '检测更新',
        message: '检查更新失败',
        detail: `${err?.message ?? err}\n\n（可能是发布仓库暂无版本，或网络问题）`,
        buttons: ['确定'],
      })
    }
  })
}

/**
 * Trigger an update check. In dev (unpackaged) electron-updater can't run, so we
 * just report the current version. `manual` = from the menu (report all results);
 * background checks stay silent unless an update exists.
 */
async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      await messageBox({
        type: 'info',
        title: '检测更新',
        message: '开发模式下不检查更新',
        detail: `仅打包安装版支持自动更新。当前版本 v${app.getVersion()}`,
        buttons: ['确定'],
      })
    }
    return
  }
  manualUpdateCheck = manual
  // Errors surface via the 'error' event handler; swallow the rejection here to
  // avoid an unhandled promise + a duplicate dialog.
  autoUpdater.checkForUpdates().catch(() => {})
}

function showAbout(): void {
  void messageBox({
    type: 'info',
    title: '关于 LMCODE',
    message: 'LMCODE Desktop',
    detail:
      `版本 v${app.getVersion()}\n` +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\n\n` +
      `基于 LMCODE CLI 的桌面客户端。\n${SOURCE_GITHUB_URL}`,
    buttons: ['确定'],
  })
}

function installApplicationMenu(): void {
  const openExternal = (url: string): void => {
    void shell.openExternal(url).catch(() => {})
  }
  const template = createAppMenuTemplate({
    appName: app.name,
    // The unpackaged one-click build is still a user-facing app. Only expose
    // reload/devtools when the dedicated development launcher opts in.
    isDevelopment: process.env['NODE_ENV'] === 'development',
    isMac: process.platform === 'darwin',
    state: desktopMenuState,
    actions: {
      dispatch: dispatchMenuCommand,
      hideWindow: () => mainWindow?.hide(),
      quit: () => {
        isQuitting = true
        app.quit()
      },
      checkForUpdates: () => void checkForUpdates(true),
      showAbout,
      openDocumentation: () =>
        openExternal(`${SOURCE_GITHUB_URL}/tree/main/apps/lmcode-desktop`),
      openChangelog: () => openExternal(DESKTOP_RELEASES_URL),
      reportIssue: () => openExternal(`${SOURCE_GITHUB_URL}/issues/new`),
      openDataDirectory: () => void shell.openPath(app.getPath('userData')),
    },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerMenuStateListener(): void {
  if (menuStateListener !== null) return
  menuStateListener = (event, state): void => {
    const targetWindow = mainWindow
    if (
      targetWindow === null ||
      trustedRendererUrl === null ||
      !isTrustedIpcSender(event, targetWindow.webContents, trustedRendererUrl) ||
      !isDesktopMenuState(state)
    ) return

    if (
      desktopMenuState.hasActiveSession === state.hasActiveSession &&
      desktopMenuState.canFindInConversation === state.canFindInConversation &&
      desktopMenuState.sidebarOpen === state.sidebarOpen &&
      desktopMenuState.canGoPrevious === state.canGoPrevious &&
      desktopMenuState.canGoNext === state.canGoNext
    ) return

    desktopMenuState = state
    installApplicationMenu()
  }
  ipcMain.on('lmcode:updateMenuState', menuStateListener)
}

function unregisterMenuStateListener(): void {
  if (menuStateListener === null) return
  ipcMain.removeListener('lmcode:updateMenuState', menuStateListener)
  menuStateListener = null
}

// ── Window ─────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    titleBarStyle: 'default',
    icon: join(__dirname, '../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the renderer fully active while hidden in the tray so streaming
      // responses and event updates are not throttled/paused.
      backgroundThrottling: false,
    },
  })

  const rendererFile = join(__dirname, '../renderer/index.html')
  const rendererUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(rendererFile).href
  trustedRendererUrl = rendererUrl

  const openExternal = (url: string): void => {
    void shell.openExternal(url).catch(() => {})
  }

  const handleNavigation = (event: Electron.Event, url: string): void => {
    const action = classifyNavigation(url, rendererUrl)
    if (action === 'allow-local') return

    event.preventDefault()
    if (action === 'open-external') openExternal(url)
  }

  // New windows are never created. Safe web links are delegated to the OS;
  // file/custom-protocol/javascript URLs are denied without being launched.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url, rendererUrl) === 'open-external') {
      openExternal(url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', handleNavigation)
  mainWindow.webContents.on('will-redirect', handleNavigation)

  // Load renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).catch((error: unknown) => {
      console.error('Failed to load the desktop renderer URL:', error)
    })
  } else {
    void mainWindow.loadFile(rendererFile).catch((error: unknown) => {
      console.error('Failed to load the desktop renderer file:', error)
    })
  }

  // Show window when ready to avoid visual flash
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Close to tray instead of quitting (unless isQuitting flag is set)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ── Harness ────────────────────────────────────────────────────────────

async function initHarness(): Promise<void> {
  // Share the user's existing LMCODE config (providers / models / API keys) that
  // the CLI already set up in `~/.lmcode/config.toml`, so model access works out
  // of the box. Sessions, memory and logs stay isolated under Electron's userData
  // so the desktop doesn't intermix with CLI session history.
  const lmcodeHome = process.env['LMCODE_HOME'] ?? join(homedir(), '.lmcode')
  harness = new LmcodeHarness({
    homeDir: app.getPath('userData'),
    configPath: join(lmcodeHome, 'config.toml'),
    uiMode: 'desktop',
  })

  // Ensure config file exists
  await harness.ensureConfigFile()

  // Register all IPC handlers
  await attachHandlersToCurrentWindow()
}

// ── App lifecycle ──────────────────────────────────────────────────────

function closeHandlerRegistration(): Promise<void> {
  if (handlerCleanup !== null) return handlerCleanup
  const registration = handlerRegistration
  handlerRegistration = null
  if (registration === null) return Promise.resolve()

  const cleanup = registration.close()
  handlerCleanup = cleanup
  void cleanup.then(
    () => {
      if (handlerCleanup === cleanup) handlerCleanup = null
    },
    () => {
      if (handlerCleanup === cleanup) handlerCleanup = null
    },
  )
  return cleanup
}

async function attachHandlersToCurrentWindow(): Promise<void> {
  if (handlerCleanup !== null) {
    await handlerCleanup.catch((error: unknown) => {
      console.error('Failed to dispose handlers for the previous window:', error)
    })
  }
  if (
    handlerRegistration !== null ||
    harness === null ||
    mainWindow === null ||
    trustedRendererUrl === null ||
    isQuitting
  ) return
  handlerRegistration = registerAllHandlers(harness, mainWindow, trustedRendererUrl)
}

const closeRuntime = onceAsync(async (options?: HarnessCloseOptions): Promise<void> => {
  if (harnessInitialization !== null) {
    await harnessInitialization.catch(() => {
      // Startup owns its failure; still close resources it managed to create.
    })
  }

  const currentHarness = harness
  harness = null

  const errors: unknown[] = []
  // Handler teardown (HTTP/IPC) and harness close (sessions, terminals) are
  // independent; run them concurrently so their latencies overlap instead of
  // stacking during shutdown.
  const results = await Promise.allSettled([
    closeHandlerRegistration(),
    currentHarness?.close(options),
  ])
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to close desktop runtime')
})

async function cleanupApplication(): Promise<void> {
  const errors: unknown[] = []
  try {
    unregisterMenuStateListener()
  } catch (error) {
    errors.push(error)
  }
  try {
    globalShortcut.unregisterAll()
  } catch (error) {
    errors.push(error)
  }
  try {
    tray?.destroy()
  } catch (error) {
    errors.push(error)
  } finally {
    tray = null
  }
  // Bound the runtime close: exit-time memory extraction is skipped here so
  // teardown stays local (memories are still captured at compaction time and
  // by the idle extractor), but the close is still raced against a fixed
  // budget in case something hangs — the underlying close keeps running in
  // the background and its errors are still logged.
  const closing = closeRuntime({ extractMemories: false }).catch((error: unknown) => {
    console.error('Failed to close desktop runtime:', error)
    errors.push(error)
  })
  const outcome = await withTimeoutBudget(closing, RUNTIME_CLOSE_BUDGET_MS)
  if (outcome === 'budget-exceeded') {
    console.warn(`[shutdown] runtime cleanup exceeded ${RUNTIME_CLOSE_BUDGET_MS}ms budget; exiting anyway`)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean up desktop application')
}

const shutdownCoordinator = new ShutdownCoordinator(
  cleanupApplication,
  () => app.quit(),
  (error) => console.error('Failed to shut down LMCODE cleanly:', error),
)

// Single-instance: launching the app again must NOT spin up a second harness
// against the same userData (sessions/SQLite) — that races the running one and
// can interrupt an in-flight task. Focus the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    registerMenuStateListener()
    installApplicationMenu()
    createWindow()
    const initialization = initHarness()
    harnessInitialization = initialization
    try {
      await initialization
    } finally {
      if (harnessInitialization === initialization) harnessInitialization = null
    }
    if (isQuitting) return
    createTray()
    registerShortcuts()
    setupAutoUpdater()
    // Silent background check a few seconds after launch (only speaks up if a
    // newer release exists). Dedicated repo → no false positives from the CLI.
    setTimeout(() => void checkForUpdates(false), 5000)
  }).catch((error: unknown) => {
    console.error('Failed to initialize LMCODE Desktop:', error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  void closeHandlerRegistration().catch((error: unknown) => {
    console.error('Failed to close desktop window resources:', error)
  })
  // Don't quit — the app keeps running in the tray
  // Only quit explicitly via tray menu or app.quit()
})

app.on('activate', () => {
  // macOS: re-create or show window when dock icon clicked
  if (mainWindow === null) {
    createWindow()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
  void attachHandlersToCurrentWindow()
})

app.on('before-quit', (event) => {
  isQuitting = true
  armShutdownWatchdog()
  shutdownCoordinator.handleBeforeQuit(event)
})
