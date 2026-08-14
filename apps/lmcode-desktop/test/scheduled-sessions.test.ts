import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { scheduledSessionIds } from '../src/main/scheduled-sessions'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function sessionSummary(id: string, hasJob: boolean): Promise<SessionSummary> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-scheduled-session-'))
  temporaryDirectories.push(sessionDir)
  if (hasJob) {
    const cronDir = path.join(sessionDir, 'cron')
    await fs.mkdir(cronDir)
    await fs.writeFile(path.join(cronDir, 'abc12345.json'), '{}', 'utf8')
  }
  return {
    id,
    workDir: sessionDir,
    sessionDir,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('desktop scheduled-session activation', () => {
  it('selects only sessions with persisted cron jobs for background resume', async () => {
    const scheduled = await sessionSummary('scheduled', true)
    const ordinary = await sessionSummary('ordinary', false)

    await expect(scheduledSessionIds([ordinary, scheduled])).resolves.toEqual(['scheduled'])
  })

  it('skips a session whose cron directory cannot be read instead of failing the whole batch', async () => {
    const scheduled = await sessionSummary('scheduled', true)
    // Corrupted session: sessionDir contains a NUL byte, so readdir on its
    // cron directory rejects with ERR_INVALID_ARG_VALUE (not ENOENT) on every
    // platform. One bad session must not silently prevent every other
    // session's cron jobs from being resumed.
    const broken: SessionSummary = {
      id: 'broken',
      workDir: 'bad\0path',
      sessionDir: 'bad\0path',
      createdAt: 1,
      updatedAt: 1,
    }

    await expect(scheduledSessionIds([broken, scheduled])).resolves.toEqual(['scheduled'])
  })
})
