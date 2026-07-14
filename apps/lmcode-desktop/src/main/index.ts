import { app, BrowserWindow, shell, Tray, Menu, nativeImage, globalShortcut, dialog } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import updaterPkg from 'electron-updater'
import { LmcodeHarness } from '@lmcode-cli/lmcode-sdk'
import { registerAllHandlers, type DesktopHandlerRegistration } from './ipc/handler.js'
import { onceAsync, ShutdownCoordinator } from './lifecycle.js'
import { classifyNavigation } from './security.js'

// electron-updater is CommonJS; destructure the default export for ESM.
const { autoUpdater } = updaterPkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

// Base64 encoded 16x16 indigo (#4F46E5) PNG for the tray icon
const INDIGO_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPwd3tKEmIY1TCqYfhqAABe7noQUrS/JQAAAABJRU5ErkJggg=='

let mainWindow: BrowserWindow | null = null
let harness: LmcodeHarness | null = null
let tray: Tray | null = null
let isQuitting = false
let trustedRendererUrl: string | null = null
let handlerRegistration: DesktopHandlerRegistration | null = null
let handlerCleanup: Promise<void> | null = null
let harnessInitialization: Promise<void> | null = null

// ── Tray icon ─────────────────────────────────────────────────────────

function createTrayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${INDIGO_ICON_BASE64}`)
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
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('lmcode:navigate', { route: 'new-session' })
      },
    },
    {
      label: '设置',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('lmcode:navigate', { route: 'settings' })
      },
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

const GITHUB_REPO = 'Lyin01/LMcode-cli'
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`

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

function navigate(route: string): void {
  showAndFocus()
  mainWindow?.webContents.send('lmcode:navigate', { route })
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
      `基于 LMCODE CLI 的桌面客户端。\n${GITHUB_URL}`,
    buttons: ['确定'],
  })
}

function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: '关于 LMCODE', click: () => showAbout() },
              { label: '检测更新…', click: () => void checkForUpdates(true) },
              { type: 'separator' as const },
              { label: '退出', accelerator: 'Cmd+Q', click: () => { isQuitting = true; app.quit() } },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => navigate('new-session') },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => navigate('settings') },
        { type: 'separator' },
        {
          label: '隐藏到托盘',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow?.hide(),
        },
        ...(!isMac
          ? [
              { type: 'separator' as const },
              { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit() } },
            ]
          : []),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        { label: '关闭', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检测更新…', click: () => void checkForUpdates(true) },
        { type: 'separator' },
        { label: '项目主页 (GitHub)', click: () => void shell.openExternal(GITHUB_URL) },
        { label: '报告问题', click: () => void shell.openExternal(`${GITHUB_URL}/issues`) },
        { label: '打开数据目录', click: () => void shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: '关于 LMCODE', click: () => showAbout() },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
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
    icon: join(__dirname, '../../resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

const closeRuntime = onceAsync(async (): Promise<void> => {
  if (harnessInitialization !== null) {
    await harnessInitialization.catch(() => {
      // Startup owns its failure; still close resources it managed to create.
    })
  }

  const currentHarness = harness
  harness = null

  const errors: unknown[] = []
  try {
    await closeHandlerRegistration()
  } catch (error) {
    errors.push(error)
  }
  try {
    await currentHarness?.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to close desktop runtime')
})

async function cleanupApplication(): Promise<void> {
  const errors: unknown[] = []
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
  try {
    await closeRuntime()
  } catch (error) {
    errors.push(error)
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
    createWindow()
    Menu.setApplicationMenu(buildAppMenu())
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
  shutdownCoordinator.handleBeforeQuit(event)
})
