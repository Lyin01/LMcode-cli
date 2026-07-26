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
})
