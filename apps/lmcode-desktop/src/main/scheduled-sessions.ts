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
    sessions.map(async (session) => ({
      id: session.id,
      scheduled: await hasPersistedCronJob(session),
    })),
  )
  return checks.filter((check) => check.scheduled).map((check) => check.id)
}
