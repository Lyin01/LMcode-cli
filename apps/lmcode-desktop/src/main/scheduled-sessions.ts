import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'

async function hasPersistedCronJob(session: SessionSummary): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(session.sessionDir, 'cron'), {
      withFileTypes: true,
    })
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function scheduledSessionIds(
  sessions: readonly SessionSummary[],
): Promise<readonly string[]> {
  const checks = await Promise.all(
    sessions.map(async (session) => {
      try {
        return { id: session.id, scheduled: await hasPersistedCronJob(session) }
      } catch (error) {
        // One corrupted session directory (permission error, invalid path,
        // etc.) must not fail the whole batch: the startup resume caller
        // swallows a rejection, which would silently skip every session's
        // persisted cron jobs. Skip the broken session instead.
        console.warn(
          `[scheduled-sessions] cannot inspect cron jobs for session ${session.id}, skipping`,
          error,
        )
        return { id: session.id, scheduled: false }
      }
    }),
  )
  return checks.filter((check) => check.scheduled).map((check) => check.id)
}
