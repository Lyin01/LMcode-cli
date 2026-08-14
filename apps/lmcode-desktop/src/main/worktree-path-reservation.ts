import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const RESERVATION_DIRECTORY = '.lmcode-worktree-reservations'
const MAX_CANDIDATES = 1_000

export interface WorktreePathReservation {
  readonly path: string
  readonly release: () => Promise<void>
}

export function worktreeSlug(branchName: string): string {
  return (
    branchName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'worktree'
  )
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Atomically reserve a candidate worktree directory below `baseDir` by
 * exclusively creating a lock file (`wx`) in a per-repository reservation
 * container. The caller holds the reservation until Git registration and
 * discovery finish; a concurrent request colliding on the same slug moves on
 * to a suffixed candidate instead of sharing the path. A candidate that
 * already exists on disk is skipped without touching its contents.
 */
export async function reserveWorktreePath(
  baseDir: string,
  branchName: string,
): Promise<WorktreePathReservation> {
  const slug = worktreeSlug(branchName)
  const reservationDir = path.join(baseDir, RESERVATION_DIRECTORY)
  await fs.mkdir(reservationDir, { recursive: true })

  for (let suffix = 1; suffix <= MAX_CANDIDATES; suffix += 1) {
    const candidateName = suffix === 1 ? slug : `${slug}-${suffix}`
    const candidatePath = path.join(baseDir, candidateName)
    const lockPath = path.join(reservationDir, `${candidateName}.lock`)
    let lockHandle: fs.FileHandle
    try {
      lockHandle = await fs.open(lockPath, 'wx')
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue
      throw error
    }

    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      await lockHandle.close().catch(() => undefined)
      await fs.unlink(lockPath).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
    }

    try {
      await fs.lstat(candidatePath)
      // The candidate already exists on disk; skip it and leave whatever it
      // contains to its owner.
      await release()
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { path: candidatePath, release }
      await release()
      throw error
    }
  }
  throw new Error('无法为工作树分配目录')
}

/**
 * Failure cleanup for a worktree path Git never populated: remove the
 * directory only while it is still empty, so a concurrent request that has
 * already checked out files into it is never deleted. Returns whether the
 * directory was removed.
 */
export async function removeEmptyWorktreeDirectory(targetPath: string): Promise<boolean> {
  try {
    await fs.rmdir(targetPath)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return false
    throw error
  }
}
