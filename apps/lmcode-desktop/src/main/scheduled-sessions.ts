import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'

function interruptibleSleep(ms: number, isClosing: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms
    const tick = (): void => {
      if (isClosing() || Date.now() >= deadline) {
        resolve()
        return
      }
      const timer = setTimeout(tick, Math.min(50, deadline - Date.now()))
      timer.unref()
    }
    tick()
  })
}

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

export async function resumeScheduledSessions(input: {
  readonly listIds: () => Promise<readonly string[]>
  readonly resume: (id: string) => Promise<void>
  readonly isClosing: () => boolean
  readonly retryDelaysMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
  readonly logWarn?: (message: string, error: unknown) => void
}): Promise<void> {
  const delays = input.retryDelaysMs ?? [0, 1_000, 4_000]
  const sleep = input.sleep ?? ((ms: number) => interruptibleSleep(ms, input.isClosing))
  let lastError: unknown
  for (const delay of delays) {
    if (input.isClosing()) return
    if (delay > 0) await sleep(delay)
    if (input.isClosing()) return
    try {
      const ids = await input.listIds()
      for (const id of ids) {
        if (input.isClosing()) return
        try {
          await input.resume(id)
        } catch (error) {
          input.logWarn?.(`cannot resume scheduled session ${id}`, error)
        }
      }
      return
    } catch (error) {
      lastError = error
      input.logWarn?.('scheduled session discovery failed, will retry', error)
    }
  }
  if (lastError !== undefined) {
    input.logWarn?.('scheduled session discovery gave up', lastError)
  }
}
