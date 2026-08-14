import { createRequire } from 'node:module'
import { resolve, relative, delimiter, dirname, join } from 'node:path'
import { existsSync, rmSync, mkdirSync, cpSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_MAIN_DIR = resolve(ROOT, 'out/main')
const OUT_PRELOAD_DIR = resolve(ROOT, 'out/preload')
const VENDOR_DIR = resolve(ROOT, 'out/vendor')
function resolveVendorPackage(spec, name, relDist, relAssets) {
  const monoMap = {
    '@lmcode-cli/lmcode-sdk': {
      pkg: resolve(ROOT, '../../packages/node-sdk/package.json'),
      dist: resolve(ROOT, '../../packages/node-sdk/dist/index.mjs'),
      assets: resolve(ROOT, '../../packages/node-sdk/dist/assets'),
    },
    '@lmcode/memory': {
      pkg: resolve(ROOT, '../../packages/memory/package.json'),
      dist: resolve(ROOT, '../../packages/memory/dist/index.mjs'),
      assets: resolve(ROOT, '../../packages/memory/dist/assets'),
    },
  }
  if (monoMap[spec] && existsSync(monoMap[spec].dist)) {
    return {
      spec,
      name,
      distEntry: monoMap[spec].dist,
      assets: monoMap[spec].assets,
      pkgPath: monoMap[spec].pkg,
    }
  }
  const localRequire = createRequire(join(ROOT, 'package.json'))
  try {
    const pkgJsonPath = localRequire.resolve(`${spec}/package.json`)
    const pkgDir = dirname(pkgJsonPath)
    return {
      spec,
      name,
      distEntry: resolve(pkgDir, relDist),
      assets: resolve(pkgDir, relAssets),
      pkgPath: pkgJsonPath,
    }
  } catch (err) {
    throw new Error(`Cannot resolve vendor dependency ${spec}: ${err.message}`)
  }
}

function resolvePlaywrightCoreRoot() {
  const localRequire = createRequire(join(ROOT, 'package.json'))
  try {
    return realpathSync(dirname(localRequire.resolve('playwright-core/package.json')))
  } catch {
    try {
      const sdkPkg = resolve(ROOT, '../../packages/node-sdk/package.json')
      const nodeSdkRequire = createRequire(sdkPkg)
      return realpathSync(dirname(nodeSdkRequire.resolve('playwright-core/package.json')))
    } catch (e) {
      throw new Error(`Cannot resolve playwright-core: ${e.message}`)
    }
  }
}

const PLAYWRIGHT_CORE_ROOT = resolvePlaywrightCoreRoot()
const PLAYWRIGHT_VENDOR_DIR = join(VENDOR_DIR, 'playwright-core')
const PLAYWRIGHT_VENDOR_ENTRY = join(PLAYWRIGHT_VENDOR_DIR, 'index.mjs')

// Ensure local + workspace-root .bin are on PATH so `vite` resolves whether this
// script is run via `pnpm run build` or a bare `node scripts/build.mjs`.
const BIN_PATH = [
  resolve(ROOT, 'node_modules/.bin'),
  resolve(ROOT, '../../node_modules/.bin'),
  process.env.PATH ?? '',
].join(delimiter)

const tsconfigRaw = {
  compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', strict: true },
}

const VENDOR = [
  resolveVendorPackage('@lmcode-cli/lmcode-sdk', 'node-sdk', 'dist/index.mjs', 'dist/assets'),
  resolveVendorPackage('@lmcode/memory', 'memory', 'dist/index.mjs', 'dist/assets'),
]

/** spec -> absolute path of its vendored bundle (filled in by vendorAll). */
const WORKSPACE_VENDOR = {}

const externalPlaywrightRuntime = {
  name: 'external-playwright-runtime',
  setup(buildContext) {
    // The full `playwright` package remains an optional user-provided override.
    buildContext.onResolve({ filter: /^playwright$/ }, () => ({
      path: 'playwright',
      external: true,
    }))
    // `playwright-core` is copied next to the self-contained SDK vendor. Keep
    // it as a real package so its package-relative JSON and helper files work.
    buildContext.onResolve({ filter: /^playwright-core$/ }, () => ({
      path: '../playwright-core/index.mjs',
      external: true,
    }))
  },
}

async function vendorPlaywrightRuntime() {
  console.log('> vendor playwright-core')
  cpSync(PLAYWRIGHT_CORE_ROOT, PLAYWRIGHT_VENDOR_DIR, {
    recursive: true,
    dereference: true,
  })
  const runtime = await import(pathToFileURL(PLAYWRIGHT_VENDOR_ENTRY).href)
  if (typeof runtime.chromium?.launch !== 'function') {
    throw new Error('Vendored playwright-core does not expose chromium.launch')
  }
}

async function vendorAll() {
  rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  await vendorPlaywrightRuntime()
  for (const v of VENDOR) {
    if (!existsSync(v.distEntry)) {
      throw new Error(
        `Missing ${v.distEntry}\nRun \`pnpm run build:packages\` from the repo root first.`,
      )
    }
    const outDir = join(VENDOR_DIR, v.name)
    mkdirSync(outDir, { recursive: true })
    const outFile = join(outDir, 'index.mjs')
    console.log(`> vendor ${v.spec}`)
    await build({
      entryPoints: [v.distEntry],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outdir: outDir,
      entryNames: 'index',
      // Force .mjs so Node treats the output as ESM (no package.json in vendor/).
      outExtension: { '.js': '.mjs' },
      external: ['electron'],
      plugins: v.name === 'node-sdk' ? [externalPlaywrightRuntime] : [],
      // Native addons that are statically required (e.g. memory's onnxruntime /
      // tokenizer) are copied next to the bundle and their paths rewritten.
      loader: { '.node': 'copy' },
      // Provide a real `require` so esbuild's __require shim handles the CJS
      // dynamic `require('fs')` / native addon requires inside bundled deps
      // (otherwise: "Dynamic require of 'fs' is not supported" at load time).
      banner: {
        js: "import { createRequire as ___createRequire } from 'node:module'; const require = ___createRequire(import.meta.url);",
      },
      logLevel: 'error',
    })
    // node-sdk loads its tokenizer addon via `createRequire('./assets/*.node')`,
    // which esbuild can't see, so copy that asset dir next to the bundle too.
    if (existsSync(v.assets)) {
      cpSync(v.assets, join(outDir, 'assets'), { recursive: true })
    }
    WORKSPACE_VENDOR[v.spec] = outFile
  }
}

/** esbuild plugin: redirect workspace imports to their vendored bundle, external. */
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
      // External, addressed by a path relative to the emitted out/main/index.js.
      let rel = relative(OUT_MAIN_DIR, vendored).replace(/\\/g, '/')
      if (!rel.startsWith('.')) rel = `./${rel}`
      return { path: rel, external: true }
    })
  },
}

// 1. Vendor the workspace packages first (the redirect target must exist).
await vendorAll()

// 1b. Ship the icon assets inside out/ so electron-builder's `files: out/**`
// picks them up for the packaged app (window icon + tray icon load from here).
{
  const resourcesOut = resolve(ROOT, 'out/resources')
  rmSync(resourcesOut, { recursive: true, force: true })
  mkdirSync(resourcesOut, { recursive: true })
  for (const asset of ['icon.png', 'tray-icon.png']) {
    const source = resolve(ROOT, 'resources', asset)
    if (!existsSync(source)) {
      throw new Error(`Missing icon asset ${source}`)
    }
    cpSync(source, join(resourcesOut, asset))
  }
  console.log('> copy icon assets to out/resources')
}

// 2. Build main (workspace packages redirected to their vendored bundle).
console.log('> esbuild main')
await build({
  entryPoints: [resolve(ROOT, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(ROOT, 'out/main/index.js'),
  external: ['electron'],
  plugins: [redirectWorkspaceToVendor],
  // Inlined CJS deps (e.g. electron-updater) may do dynamic require()s; define a
  // real require via createRequire so the ESM bundle doesn't throw at runtime.
  banner: {
    js: "import { createRequire as ___createRequire } from 'node:module'; const require = ___createRequire(import.meta.url);",
  },
  tsconfigRaw,
  logLevel: 'info',
})

// 3. Build preload
console.log('> esbuild preload')
rmSync(OUT_PRELOAD_DIR, { recursive: true, force: true })
await build({
  entryPoints: [resolve(ROOT, 'src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  // Sandboxed preload scripts run in Electron's restricted CommonJS
  // environment and cannot use ESM imports.
  format: 'cjs',
  outfile: resolve(OUT_PRELOAD_DIR, 'index.cjs'),
  external: ['electron'],
  tsconfigRaw,
  logLevel: 'info',
})

// 4. Build renderer
console.log('> vite build renderer')
execSync('vite build --config vite.renderer.config.ts', {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PATH: BIN_PATH },
})

console.log('\n✅ 构建完成')
console.log('启动: cd apps/lmcode-desktop && npx electron .')
