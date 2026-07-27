// Development launcher.
//
// `electron-vite dev` cannot be used here: its main/preload pipeline lacks the
// vendor redirection + createRequire banner that scripts/build.mjs applies (see
// the long comment there), so it produces a main process that crashes on the
// native tokenizer addon. This script instead mirrors the REAL build path:
//
//   1. Ensure out/vendor exists (full build.mjs run if missing)
//   2. esbuild --watch for main + preload (same options as build.mjs)
//   3. vite dev server for the renderer (HMR)
//   4. Launch Electron with ELECTRON_RENDERER_URL; restart it when main or
//      preload rebuilds
//
// Renderer changes hot-reload instantly; main/preload changes restart Electron
// automatically. Workspace package changes (packages/*) require a full
// `pnpm run build` first — the vendor bundles are not rebuilt here.
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve, relative, delimiter, dirname } from 'node:path'
import { context } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_MAIN_DIR = resolve(ROOT, 'out/main')
const OUT_PRELOAD_DIR = resolve(ROOT, 'out/preload')
const VENDOR_DIR = resolve(ROOT, 'out/vendor')
const RENDERER_PORT = 5173
const RENDERER_URL = `http://localhost:${RENDERER_PORT}`

const BIN_PATH = [
  resolve(ROOT, 'node_modules/.bin'),
  resolve(ROOT, '../../node_modules/.bin'),
  process.env.PATH ?? '',
].join(delimiter)

// Deterministic mirror of the VENDOR list in scripts/build.mjs. The vendor
// output paths are fixed by build.mjs (`out/vendor/<name>/index.mjs`).
const WORKSPACE_VENDOR = {
  '@lmcode-cli/lmcode-sdk': resolve(VENDOR_DIR, 'node-sdk/index.mjs'),
  '@lmcode/memory': resolve(VENDOR_DIR, 'memory/index.mjs'),
}

// Same createRequire banner as build.mjs — required for CJS dynamic requires
// inside bundled deps.
const CREATE_REQUIRE_BANNER =
  "import { createRequire as ___createRequire } from 'node:module'; const require = ___createRequire(import.meta.url);"

const TSCONFIG_RAW = {
  compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', strict: true },
}

// ── 1. Ensure vendor bundles exist ─────────────────────────────────────────
if (!Object.values(WORKSPACE_VENDOR).every((p) => existsSync(p))) {
  console.log('> out/vendor 缺失，先执行一次完整构建')
  execSync('node scripts/build.mjs', { cwd: ROOT, stdio: 'inherit' })
}

// ── 2. esbuild watch contexts (mirrors build.mjs steps 2 & 3) ──────────────
const redirectWorkspaceToVendor = {
  name: 'redirect-workspace-to-vendor',
  setup(build) {
    build.onResolve({ filter: /^@lmcode(-cli)?\// }, (args) => {
      const vendored = WORKSPACE_VENDOR[args.path]
      if (!vendored) {
        return {
          errors: [{
            text: `No vendor mapping for workspace import "${args.path}". ` +
              `Add it to VENDOR in scripts/build.mjs.`,
          }],
        }
      }
      let rel = relative(OUT_MAIN_DIR, vendored).replace(/\\/g, '/')
      if (!rel.startsWith('.')) rel = `./${rel}`
      return { path: rel, external: true }
    })
  },
}

let electronProcess = null
let restartTimer = null
let shuttingDown = false
// esbuild's watch() fires one more build right after startup; restarts are
// only meaningful for builds triggered by actual edits later on.
let electronStartedAt = 0

function scheduleElectronRestart() {
  if (shuttingDown || !electronProcess) return
  if (Date.now() - electronStartedAt < 2000) return
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    console.log('> main/preload 已重建，重启 Electron')
    const old = electronProcess
    electronProcess = null
    old?.once('exit', startElectron)
    old?.kill()
    // Fallback in case 'exit' never fires.
    setTimeout(() => {
      if (!electronProcess && !shuttingDown) startElectron()
    }, 3000).unref()
  }, 300)
}

const restartOnRebuild = {
  name: 'restart-electron-on-rebuild',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) scheduleElectronRestart()
    })
  },
}

const mainCtx = await context({
  entryPoints: [resolve(ROOT, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(OUT_MAIN_DIR, 'index.js'),
  external: ['electron'],
  plugins: [redirectWorkspaceToVendor, restartOnRebuild],
  banner: { js: CREATE_REQUIRE_BANNER },
  tsconfigRaw: TSCONFIG_RAW,
  logLevel: 'info',
})

const preloadCtx = await context({
  entryPoints: [resolve(ROOT, 'src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  // Sandboxed preload scripts run in Electron's restricted CommonJS
  // environment and cannot use ESM imports.
  format: 'cjs',
  outfile: resolve(OUT_PRELOAD_DIR, 'index.cjs'),
  external: ['electron'],
  plugins: [restartOnRebuild],
  tsconfigRaw: TSCONFIG_RAW,
  logLevel: 'info',
})

await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()])
await Promise.all([mainCtx.watch(), preloadCtx.watch()])

// ── 3. Renderer dev server (HMR) ───────────────────────────────────────────
console.log('> vite dev renderer')
// Spawn vite through its JS entry (no shell) to avoid DEP0190 and quoting issues.
const viteBin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
const viteProcess = spawn(
  process.execPath,
  [viteBin, '--config', 'vite.renderer.config.ts', '--port', String(RENDERER_PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PATH: BIN_PATH } },
)

async function waitForRenderer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(RENDERER_URL, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`Renderer dev server did not start within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── 4. Launch Electron ─────────────────────────────────────────────────────
const electronBinary = createRequire(resolve(ROOT, 'package.json'))('electron')

function startElectron() {
  if (electronProcess || shuttingDown) return
  electronStartedAt = Date.now()
  electronProcess = spawn(electronBinary, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_RENDERER_URL: RENDERER_URL,
    },
  })
  electronProcess.once('exit', () => {
    const wasRestart = restartTimer !== null && electronProcess === null
    electronProcess = null
    // User closed the window (not a rebuild restart) → shut everything down.
    if (!wasRestart) void shutdown(0)
  })
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)
  electronProcess?.kill()
  viteProcess.kill()
  await Promise.allSettled([mainCtx.dispose(), preloadCtx.dispose()])
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

await waitForRenderer()
startElectron()
console.log(`\n✅ 开发模式已启动（renderer HMR: ${RENDERER_URL}）`)
console.log('   修改 src/renderer 即时热更新；修改 src/main / src/preload 会自动重启 Electron')
