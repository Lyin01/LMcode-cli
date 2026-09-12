import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { canonicalizeShellOpenBasename } from '../shared/open-path-guard.js'

const EXECUTABLE_SIBLING_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const

export type ShellOpenTargetCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * `shell.openPath` resolves extensionless paths through the Windows shell,
 * which appends `.exe` (verified: `C:\Windows\System32\whoami` launches
 * whoami.exe). A path taken from model output must therefore not become a
 * one-click executable just because it has no extension. The pure string
 * guard in shared/open-path-guard.ts cannot see that, so probe the filesystem
 * here before handing the target to the shell.
 */
export async function checkShellOpenTarget(
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ShellOpenTargetCheck> {
  let info
  try {
    info = await stat(target)
  } catch {
    return { ok: false, reason: '路径不存在或无法访问' }
  }
  if (info.isDirectory()) return { ok: true }
  if (!info.isFile()) return { ok: false, reason: '仅支持打开普通文件或目录' }
  if (platform !== 'win32') return { ok: true }

  const canonical = canonicalizeShellOpenBasename(basename(target))
  const dot = canonical.lastIndexOf('.')
  if (dot > 0 && dot < canonical.length - 1) return { ok: true }

  const probeBase = join(dirname(target), canonical)
  for (const extension of EXECUTABLE_SIBLING_EXTENSIONS) {
    try {
      const sibling = await stat(`${probeBase}${extension}`)
      if (sibling.isFile()) {
        return {
          ok: false,
          reason: '无扩展名路径会命中同名可执行文件，已阻止；请用「在资源管理器中显示」',
        }
      }
    } catch {
      // No such sibling — keep probing the remaining extensions.
    }
  }
  return { ok: true }
}
