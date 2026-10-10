import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_NAMES = ['lm.exe']
const UNIX_NAMES = ['lm']

function namesForPlatform(): readonly string[] {
  return process.platform === 'win32' ? WINDOWS_NAMES : UNIX_NAMES
}

function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => candidate.length > 0 && existsSync(candidate))
}

/**
 * Resolve the `lm` binary. An explicit path wins. A dev checkout falls back to
 * `target/debug` then `target/release`. The packaged app looks beside the
 * executable. The last resort is `lm` on PATH.
 */
export function resolveLmBinary(explicit?: string): string {
  const fromCaller = explicit?.trim()
  if (fromCaller !== undefined && fromCaller.length > 0 && existsSync(fromCaller)) return fromCaller
  const fromEnv = process.env['LMCODE_BIN']?.trim() || process.env['CARGO_BIN_EXE_lm']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv

  const names = namesForPlatform()
  const besideExecutable = names.map((name) => join(dirname(process.execPath), name))
  const resources = process.resourcesPath
  const besideResources = resources === undefined ? [] : names.map((name) => join(resources, name))
  const foundBeside = firstExisting([...besideExecutable, ...besideResources])
  if (foundBeside !== undefined) return foundBeside

  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'Cargo.toml'))) {
      const built: string[] = []
      for (const profile of ['debug', 'release']) {
        for (const name of names) built.push(join(dir, 'target', profile, name))
      }
      const match = firstExisting(built)
      if (match !== undefined) return match
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'lm'
}
