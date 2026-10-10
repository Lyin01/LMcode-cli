import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RustHarness } from '../src/main/rust-core/harness'
import type { DesktopSession } from '../src/main/rust-core/types'

const directories: string[] = []
const openHarnesses: RustHarness[] = []

async function removeDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}

afterEach(async () => {
  await Promise.all(
    openHarnesses.splice(0).map((harness) => harness.close().catch(() => undefined)),
  )
  await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)))
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function startHarness(home: string): Promise<RustHarness> {
  const harness = await RustHarness.start({
    homeDir: home,
    configPath: join(home, 'config.toml'),
  })
  openHarnesses.push(harness)
  return harness
}

function waitForTurnEnd(session: DesktopSession): Promise<{ type: string; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn did not end')), 40_000)
    session.onEvent((event) => {
      if (event.type === 'turn.ended') {
        clearTimeout(timer)
        resolve({ type: event.type, reason: event.reason })
      }
    })
  })
}

describe('desktop client of lm app-server', () => {
  it('launches the real binary twice and the turn plus panel reads agree', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')

    const first = await startHarness(home)
    await first.ensureConfigFile()
    const session = await first.createSession({ workDir: work, model: 'script' })
    const ended = waitForTurnEnd(session)
    await session.prompt('hello')
    const turn = await ended
    const context = await session.getContext()
    const config = await first.getConfig()
    const memories = await first.memoryStore().list({ limit: 20 })
    expect(turn).toEqual({ type: 'turn.ended', reason: 'completed' })
    expect(JSON.stringify(context.history)).toContain('hello')
    expect(JSON.stringify(context.history)).toContain('script: hello')
    expect(config.providers).toEqual(expect.any(Object))
    expect(first.capturedStderr()).toBe('')
    await first.close()

    const second = await startHarness(home)
    const listed = await second.listSessions()
    expect(listed.map((item) => item.id)).toContain(session.id)
    const resumed = await second.resumeSession({ id: session.id })
    const again = await resumed.getContext()
    const configAgain = await second.getConfig()
    const memoriesAgain = await second.memoryStore().list({ limit: 20 })
    expect(again.history).toEqual(context.history)
    expect(configAgain).toEqual(config)
    expect(memoriesAgain).toEqual(memories)
    expect(second.capturedStderr()).toBe('')
    console.log(JSON.stringify({
      turn,
      history: again.history,
      config: configAgain,
      memories: memoriesAgain.memos,
    }))
    await second.close()
  }, 60_000)

  it('forwards bash approval and question reverse requests', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const harness = await startHarness(home)
    await harness.ensureConfigFile()

    const bash = await harness.createSession({ workDir: work, model: 'script-bash' })
    const approved = waitForTurnEnd(bash)
    let command = ''
    bash.setApprovalHandler(async (request) => {
      command = request.display.kind === 'command' ? request.display.command : ''
      return { decision: 'approved' }
    })
    await bash.prompt('run')
    await expect(approved).resolves.toEqual({ type: 'turn.ended', reason: 'completed' })
    expect(command).toBe('echo hi')

    const ask = await harness.createSession({ workDir: work, model: 'script-ask' })
    const answered = waitForTurnEnd(ask)
    let question = ''
    ask.setQuestionHandler(async (request) => {
      question = request.questions[0]?.question ?? ''
      return { answers: { A: true } }
    })
    await ask.prompt('ask')
    await expect(answered).resolves.toEqual({ type: 'turn.ended', reason: 'completed' })
    expect(question).toBe('Which?')
  }, 90_000)

  it('rejects a second turn while one is running', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const harness = await startHarness(home)
    await harness.ensureConfigFile()
    const session = await harness.createSession({ workDir: work, model: 'script-pause' })
    const ended = waitForTurnEnd(session)
    const first = session.prompt('hello')
    await expect(session.prompt('again')).rejects.toThrow('a turn is already running')
    await first
    await expect(ended).resolves.toEqual({ type: 'turn.ended', reason: 'completed' })
  }, 60_000)
})
