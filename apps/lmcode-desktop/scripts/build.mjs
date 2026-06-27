import { resolve, relative, delimiter, join } from 'node:path'
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_MAIN_DIR = resolve(ROOT, 'out/main')
const VENDOR_DIR = resolve(ROOT, 'out/vendor')

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

// ── Vendor workspace packages ──────────────────────────────────────────────
//
// `@lmcode-cli/*` / `@lmcode/*` package.json `exports` deliberately point at
// `./src/index.ts` (TS-source-first dev model) and their `#/*` subpath imports
// are not valid Node specifiers, so the raw source cannot run under Node. Each
// already ships a built `dist/index.mjs`, but that dist externalizes its npm
// deps (undici, zod, @google/genai, …) and loads a native tokenizer addon via
// `createRequire('./assets/*.node')` — neither survives `electron-builder`
// packaging (no node_modules in the app, native modules can't live in asar).
//
// So we re-bundle each dist into a SELF-CONTAINED file under `out/vendor/`:
// npm deps are inlined, `*.node` stays an external runtime require, and the
// sibling `assets/` (native addon) is copied next to the bundle so the
// createRequire path still resolves. `out/vendor/` ships inside the app, making
// the main process fully portable.
const VENDOR = [
  {
    spec: '@lmcode-cli/lmcode-sdk',
    name: 'node-sdk',
    distEntry: resolve(ROOT, '../../packages/node-sdk/dist/index.mjs'),
    assets: resolve(ROOT, '../../packages/node-sdk/dist/assets'),
  },
  {
    spec: '@lmcode/memory',
    name: 'memory',
    distEntry: resolve(ROOT, '../../packages/memory/dist/index.mjs'),
    assets: resolve(ROOT, '../../packages/memory/dist/assets'),
  },
]

/** spec -> absolute path of its vendored bundle (filled in by vendorAll). */
const WORKSPACE_VENDOR = {}

async function vendorAll() {
  rmSync(VENDOR_DIR, { recursive: true, force: true })
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
await build({
  entryPoints: [resolve(ROOT, 'src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(ROOT, 'out/preload/index.mjs'),
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
console.log('启动: cd apps/lmcode-desktop && npx electron . --no-sandbox')
