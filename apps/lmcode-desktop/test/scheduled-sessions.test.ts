import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SessionSummary } from '@lmcode-cli/lmcode-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeScheduledSessions, scheduledSessionIds } from '../src/main/scheduled-sessions'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

type CronFixture = 'none' | 'jobs' | 'empty-dir'

async function sessionSummary(id: string, cron: CronFixture): Promise<SessionSummary> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-scheduled-session-'))
  temporaryDirectories.push(sessionDir)
  if (cron !== 'none') {
    // Real on-disk layout: only the main agent owns a cron manager, so
    // persisted jobs land under `<sessionDir>/agents/main/cron/<id>.json`.
    const cronDir = path.join(sessionDir, 'agents', 'main', 'cron')
    await fs.mkdir(cronDir, { recursive: true })
    if (cron === 'jobs') {
      await fs.writeFile(path.join(cronDir, 'abc12345.json'), '{}', 'utf8')
    }
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
    const scheduled = await sessionSummary('scheduled', 'jobs')
    const ordinary = await sessionSummary('ordinary', 'none')

    await expect(scheduledSessionIds([ordinary, scheduled])).resolves.toEqual(['scheduled'])
  })

  it('does not select sessions whose main-agent cron directory holds no job files', async () => {
    const empty = await sessionSummary('empty', 'empty-dir')
    const ordinary = await sessionSummary('ordinary', 'none')

    await expect(scheduledSessionIds([ordinary, empty])).resolves.toEqual([])
  })

  it('skips a session whose cron directory cannot be read instead of failing the whole batch', async () => {
    const scheduled = await sessionSummary('scheduled', 'jobs')
    // Corrupted session: sessionDir contains a NUL byte, so readdir on its
    // main-agent cron directory rejects with ERR_INVALID_ARG_VALUE (not
    // ENOENT) on every platform. One bad session must not silently prevent
    // every other session's cron jobs from being resumed.
    const broken: SessionSummary = {
      id: 'broken',
      workDir: 'bad\0path',
      sessionDir: 'bad\0path',
      createdAt: 1,
      updatedAt: 1,
    }

    await expect(scheduledSessionIds([broken, scheduled])).resolves.toEqual(['scheduled'])
  })

  it('retries scheduled discovery after a listSessions failure', async () => {
    let attempts = 0
    const resumed: string[] = []
    await resumeScheduledSessions({
      listIds: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('store locked')
        return ['cron-a']
      },
      resume: async (id) => {
        resumed.push(id)
      },
      isClosing: () => false,
      retryDelaysMs: [0, 0],
      sleep: async () => undefined,
    })

    expect(attempts).toBe(2)
    expect(resumed).toEqual(['cron-a'])
  })
})
