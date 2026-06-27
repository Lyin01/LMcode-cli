import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

/**
 * esbuild plugin: resolve `#/foo` imports in workspace packages
 * by consulting each package's `imports` field in package.json
 */
export function resolveHashImports() {
  const importMaps = new Map() // dir -> imports object
  const PKG_CACHE = new Map()  // file -> package.json dir

  function findPackageJson(path) {
    let dir = dirname(path)
    while (dir.length > 0) {
      const cached = PKG_CACHE.get(dir)
      if (cached !== undefined) return cached
      const p = resolve(dir, 'package.json')
      if (existsSync(p)) {
        PKG_CACHE.set(dir, dir)
        return dir
      }
      const next = resolve(dir, '..')
      if (next === dir) break
      dir = next
    }
    return null
  }

  function getImportMap(pkgDir) {
    if (!pkgDir) return null
    let cached = importMaps.get(pkgDir)
    if (cached !== undefined) return cached
    try {
      const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))
      cached = pkg.imports ?? null
      importMaps.set(pkgDir, cached)
      return cached
    } catch { return null }
  }

  return {
    name: 'resolve-hash-imports',
    setup(build) {
      build.onResolve({ filter: /^#\// }, (args) => {
        const pkgDir = findPackageJson(args.importer)
        const imports = getImportMap(pkgDir)
        if (!imports) {
          return { errors: [{ text: `#/ import found but no imports map in package.json for ${args.importer}` }] }
        }

        // 1. Try exact match first (e.g., "#/session" -> "./src/session/index.ts")
        const specifier = args.path
        if (imports[specifier]) {
          const patterns = Array.isArray(imports[specifier]) ? imports[specifier] : [imports[specifier]]
          for (const p of patterns) {
            const fullPath = resolve(pkgDir, p)
            if (existsSync(fullPath)) return { path: fullPath }
          }
        }

        // 2. Try wildcard match "#/*"
        const wildcard = imports['#/*']
        if (wildcard) {
          const relativePath = args.path.slice(2) // remove '#/'
          const patterns = Array.isArray(wildcard) ? wildcard : [wildcard]
          for (const pattern of patterns) {
            const resolved = pattern.replace('*', relativePath)
            const fullPath = resolve(pkgDir, resolved)
            if (existsSync(fullPath)) return { path: fullPath }
          }
        }

        return {
          errors: [{
            text: `Cannot resolve "${args.path}" in ${pkgDir}/package.json imports. ` +
                  `Available keys: ${Object.keys(imports).join(', ')}`
          }]
        }
      })
    }
  }
}
