import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
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

async function zipText(path: string): Promise<string> {
  const data = await readFile(path)
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error(`not a zip: ${path}`)
  const cdSize = data.readUInt32LE(eocd + 12)
  const cdOffset = data.readUInt32LE(eocd + 16)
  let cursor = cdOffset
  const end = cdOffset + cdSize
  const chunks: string[] = []
  while (cursor + 46 <= end) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) break
    const method = data.readUInt16LE(cursor + 10)
    const compressed = data.readUInt32LE(cursor + 20)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const localOffset = data.readUInt32LE(cursor + 42)
    const localName = data.readUInt16LE(localOffset + 26)
    const localExtra = data.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const bytes = data.subarray(start, start + compressed)
    const raw = method === 0 ? bytes : inflateRawSync(bytes)
    chunks.push(raw.toString('utf8'))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return chunks.join('\n')
}

async function startHarness(home: string): Promise<RustHarness> {
  const harness = await RustHarness.start({
    homeDir: home,
    configPath: join(home, 'config.toml'),
  })
  openHarnesses.push(harness)
  return harness
}

async function waitForPing(
  session: DesktopSession,
  exceptTaskId?: string,
): Promise<{ taskId: string; startedAt: number }> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const tasks = await session.listBackgroundTasks({ activeOnly: false })
    const task = tasks.find(
      (item) =>
        item.status === 'running' &&
        item.command.includes('127.0.0.1') &&
        item.taskId !== exceptTaskId,
    )
    if (task !== undefined) {
      const output = await session.getBackgroundTaskOutput(task.taskId)
      if (output.includes('127.0.0.1')) {
        return { taskId: task.taskId, startedAt: task.startedAt }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('running ping did not appear')
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

function waitForEvents(
  session: DesktopSession,
  types: readonly string[],
): Promise<Array<{ readonly type: string } & Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const seen: Array<{ readonly type: string } & Record<string, unknown>> = []
    const timer = setTimeout(() => {
      reject(new Error(`missing events ${types.join(', ')}; saw ${seen.map((event) => event.type).join(', ')}`))
    }, 40_000)
    session.onEvent((event) => {
      seen.push(event as unknown as { readonly type: string } & Record<string, unknown>)
      const ready = types.every((type) => seen.some((item) => item.type === type))
      if (!ready) return
      clearTimeout(timer)
      resolve(seen)
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
    const endedAgain = waitForTurnEnd(resumed)
    await resumed.prompt('again')
    const turnAgain = await endedAgain
    const again = await resumed.getContext()
    const configAgain = await second.getConfig()
    const memoriesAgain = await second.memoryStore().list({ limit: 20 })
    expect(turnAgain).toEqual({ type: 'turn.ended', reason: 'completed' })
    expect(JSON.stringify(again.history)).toContain('hello')
    expect(JSON.stringify(again.history)).toContain('script: hello')
    expect(JSON.stringify(again.history)).toContain('again')
    expect(JSON.stringify(again.history)).toContain('script: again')
    expect(configAgain).toEqual(config)
    expect(memoriesAgain).toEqual(memories)
    expect(second.capturedStderr()).toBe('')
    console.log(JSON.stringify({
      runs: [
        { turn, history: context.history, config, memories: memories.memos },
        { turn: turnAgain, history: again.history, config: configAgain, memories: memoriesAgain.memos },
      ],
    }))
    await second.close()
  }, 90_000)

  it('emits goal.updated for create, pause, and cancel', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const harness = await startHarness(home)
    await harness.ensureConfigFile()
    const session = await harness.createSession({ workDir: work, model: 'script' })
    const seen: Array<{ readonly type: string; readonly snapshot: unknown; readonly change?: unknown }> = []
    session.onEvent((event) => {
      if (event.type === 'goal.updated') {
        seen.push(event as { readonly type: string; readonly snapshot: unknown; readonly change?: unknown })
      }
    })

    const created = await session.createGoal('ship the rust core')
    expect(seen.at(-1)).toMatchObject({
      type: 'goal.updated',
      agentId: 'main',
      sessionId: session.id,
      change: { kind: 'lifecycle', status: 'active', actor: 'user' },
    })
    expect(seen.at(-1)?.snapshot).toEqual(created)

    const paused = await session.updateGoalStatus('paused')
    expect(seen.at(-1)).toMatchObject({
      type: 'goal.updated',
      change: { kind: 'lifecycle', status: 'paused', actor: 'user' },
    })
    expect(seen.at(-1)?.snapshot).toEqual(paused)

    const cancelled = await session.cancelGoal()
    expect(seen.at(-1)).toMatchObject({
      type: 'goal.updated',
      change: { kind: 'completion', status: 'complete', reason: 'cancelled', actor: 'user' },
    })
    expect(seen.at(-1)?.snapshot).toEqual(cancelled)
    expect(harness.capturedStderr()).toBe('')
  }, 60_000)

  it('runs a due cron job and emits cron.fired', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const harness = await startHarness(home)
    await harness.ensureConfigFile()
    const session = await harness.createSession({ workDir: work, model: 'script' })
    const sessionDir = session.summary?.sessionDir
    if (sessionDir === undefined || sessionDir.length === 0) {
      throw new Error('sessionDir missing')
    }
    await harness.close()

    await mkdir(join(sessionDir, 'cron'), { recursive: true })
    await writeFile(join(sessionDir, 'cron', 'duejob01.json'), JSON.stringify({
      id: 'duejob01',
      cron: '* * * * *',
      prompt: 'ping the build',
      createdAt: Date.now() - 10 * 60_000,
      recurring: true,
    }))

    const again = await startHarness(home)
    const resumed = await again.resumeSession({ id: session.id })
    const events = await waitForEvents(resumed, ['cron.fired', 'turn.ended'])
    const fired = events.find((event) => event.type === 'cron.fired')
    expect(fired).toMatchObject({
      type: 'cron.fired',
      agentId: 'main',
      sessionId: session.id,
      prompt: 'ping the build',
      origin: {
        kind: 'cron_job',
        jobId: 'duejob01',
        cron: '* * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
    })
    expect(events.find((event) => event.type === 'turn.ended')).toMatchObject({
      type: 'turn.ended',
      reason: 'completed',
    })
    const jobs = await resumed.listCronJobs()
    expect(jobs.map((job) => job.id)).toContain('duejob01')
    expect(jobs.find((job) => job.id === 'duejob01')?.lastFiredAt).toEqual(expect.any(Number))
    expect(again.capturedStderr()).toBe('')
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

  it('keeps session controls and worktree metadata across a second process', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const tree = await tempDir('lmcode-desktop-tree-')
    const first = await startHarness(home)
    await first.ensureConfigFile()
    const session = await first.createSession({
      workDir: work,
      model: 'script',
      thinking: 'low',
      permission: 'auto',
    })
    expect(await session.getStatus()).toMatchObject({
      model: 'script',
      thinkingLevel: 'low',
      permission: 'auto',
      planMode: false,
    })

    await session.setModel('script-ask')
    expect(await session.getStatus()).toMatchObject({ model: 'script-ask', thinkingLevel: 'low' })
    await session.setThinking('high')
    expect(await session.getStatus()).toMatchObject({ thinkingLevel: 'high' })
    await session.setPermission('yolo')
    expect(await session.getStatus()).toMatchObject({ permission: 'yolo' })
    await session.setPlanMode(true)
    const status = await session.getStatus()
    expect(status).toMatchObject({
      model: 'script-ask',
      thinkingLevel: 'high',
      permission: 'yolo',
      planMode: true,
    })

    const fork = await first.forkSession({
      id: session.id,
      workDir: tree,
      metadata: {
        desktopWorktree: {
          branch: 'feature/rust',
          path: tree,
          sourceSessionId: session.id,
        },
      },
    })
    expect(fork.summary?.metadata).toEqual({
      desktopWorktree: {
        branch: 'feature/rust',
        path: tree,
        sourceSessionId: session.id,
      },
    })
    const forkId = fork.id
    await first.close()

    const second = await startHarness(home)
    const resumed = await second.resumeSession({ id: session.id })
    expect(await resumed.getStatus()).toEqual(status)
    const resumedFork = await second.resumeSession({ id: forkId })
    expect(resumedFork.summary?.metadata).toEqual({
      desktopWorktree: {
        branch: 'feature/rust',
        path: tree,
        sourceSessionId: session.id,
      },
    })
    expect(await resumedFork.getStatus()).toMatchObject({
      model: 'script-ask',
      thinkingLevel: 'high',
      permission: 'yolo',
      planMode: true,
    })
    expect(second.capturedStderr()).toBe('')
  }, 60_000)

  it('undo removes the last turn and compact leaves a shorter history', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const first = await startHarness(home)
    await first.ensureConfigFile()
    const session = await first.createSession({ workDir: work, model: 'script' })
    const keep = 'alpha-turn-keep-this-sentence'
    const drop = 'beta-turn-remove-this-sentence'
    let ended = waitForTurnEnd(session)
    await session.prompt(keep)
    await ended
    ended = waitForTurnEnd(session)
    await session.prompt(drop)
    await ended

    const before = await session.getContext()
    await session.undoHistory(1)
    const undone = await session.getContext()
    expect(JSON.stringify(undone.history)).toContain(keep)
    expect(JSON.stringify(undone.history)).not.toContain(drop)
    expect(undone.history.length).toBeLessThan(before.history.length)

    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('compaction did not complete')), 40_000)
      session.onEvent((event) => {
        if (event.type === 'compaction.completed') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    await session.compact()
    await completed
    const compacted = await session.getContext()
    expect(compacted.history.length).toBeLessThan(undone.history.length)
    expect(JSON.stringify(compacted.history)).toContain('[Context compaction]')
    const sessionId = session.id
    await first.close()

    const second = await startHarness(home)
    const resumed = await second.resumeSession({ id: sessionId })
    expect(await resumed.getContext()).toEqual(compacted)
    expect(second.capturedStderr()).toBe('')
  }, 60_000)

  it('lists a real skill and stops a background command from a turn', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const skillDir = join(work, '.lmcode', 'skills', 'desk-probe')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: desk-probe\ndescription: probe the desktop skill list\n---\n\nFollow the desk-probe-body instructions.\n',
    )
    const harness = await startHarness(home)
    await harness.ensureConfigFile()
    const session = await harness.createSession({ workDir: work, model: 'script' })
    const skills = (await session.listSkills()) as Array<{
      name: string
      source: string
      path: string
      description: string
    }>
    const skill = skills.find((item) => item.name === 'desk-probe')
    expect(skill?.description).toBe('probe the desktop skill list')
    expect(skill?.source).toBe('project')
    expect(skill?.path.split('\\').join('/')).toContain('.lmcode/skills/desk-probe/SKILL.md')

    const ended = waitForTurnEnd(session)
    await session.activateSkill('desk-probe', 'with-arg')
    await ended
    const rendered = JSON.stringify((await session.getContext()).history)
    expect(rendered).toContain('desk-probe-body')
    expect(rendered).toContain('with-arg')

    await session.setModel('script-bg')
    await session.setPermission('yolo')
    const backgroundEnded = waitForTurnEnd(session)
    await session.prompt('start the background command')
    await backgroundEnded

    const first = await waitForPing(session)
    expect(Math.abs(first.startedAt - Date.now())).toBeLessThan(60_000)
    expect(first.startedAt).toBeGreaterThanOrEqual(1_000_000_000_000)
    await session.getContext()
    const still = (await session.listBackgroundTasks({ activeOnly: true })).find(
      (item) => item.taskId === first.taskId,
    )
    expect(still?.status).toBe('running')
    expect(Math.abs((still?.startedAt ?? 0) - Date.now())).toBeLessThan(60_000)
    expect(await session.getBackgroundTaskOutput(first.taskId)).toContain('127.0.0.1')
    await session.stopBackgroundTask(first.taskId, { reason: 'test stop' })
    const active = await session.listBackgroundTasks({ activeOnly: true })
    expect(active.some((item) => item.taskId === first.taskId)).toBe(false)
    const killed = (await session.listBackgroundTasks({ activeOnly: false })).find(
      (item) => item.taskId === first.taskId,
    )
    expect(killed?.status).toBe('killed')
    expect(killed?.endedAt).not.toBeNull()
    expect(killed?.endedAt ?? 0).toBeGreaterThanOrEqual(first.startedAt)
    expect(Math.abs((killed?.endedAt ?? 0) - Date.now())).toBeLessThan(60_000)

    await session.setModel('script-bg')
    const secondEnded = waitForTurnEnd(session)
    await session.prompt('start the second background command')
    await secondEnded
    const second = await waitForPing(session, first.taskId)
    const otherWork = await tempDir('lmcode-desktop-work-')
    await harness.createSession({ workDir: otherWork, model: 'script' })
    const back = await harness.resumeSession({ id: session.id })
    const resumed = (await back.listBackgroundTasks({ activeOnly: true })).find(
      (item) => item.taskId === second.taskId,
    )
    expect(resumed?.status).toBe('running')
    expect(await back.getBackgroundTaskOutput(second.taskId)).toContain('127.0.0.1')
    expect(Math.abs(second.startedAt - Date.now())).toBeLessThan(60_000)
    await back.stopBackgroundTask(second.taskId, { reason: 'second stop' })
    const secondActive = await back.listBackgroundTasks({ activeOnly: true })
    expect(secondActive.some((item) => item.taskId === second.taskId)).toBe(false)
    const secondKilled = (await back.listBackgroundTasks({ activeOnly: false })).find(
      (item) => item.taskId === second.taskId,
    )
    expect(secondKilled?.status).toBe('killed')
    expect(secondKilled?.endedAt).not.toBeNull()
    expect(secondKilled?.endedAt ?? 0).toBeGreaterThanOrEqual(second.startedAt)
    expect(Math.abs((secondKilled?.endedAt ?? 0) - Date.now())).toBeLessThan(60_000)
  }, 90_000)

  it('exports a zip, reports the context window, and keeps image parts', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_provider = "local"',
        'default_model = "script"',
        '',
        '[providers.local]',
        'type = "openai"',
        'api_key = "test"',
        'base_url = "http://127.0.0.1:9/v1"',
        '',
        '[models.script]',
        'provider = "local"',
        'model = "script"',
        'max_context_size = 8192',
        '',
      ].join('\n'),
    )
    const harness = await startHarness(home)
    await harness.ensureConfigFile()
    const session = await harness.createSession({ workDir: work, model: 'script' })
    const prompt = 'plain-user-sentence'
    const ended = waitForTurnEnd(session)
    await session.prompt(prompt)
    await ended
    const status = await session.getStatus()
    const expectedTokens = prompt.length + `script: ${prompt}`.length
    expect(status.maxContextTokens).toBe(8192)
    expect(status.contextTokens).toBe(expectedTokens)
    expect(status.contextUsage).toBe(expectedTokens / 8192)

    const pictured = waitForTurnEnd(session)
    await session.prompt([
      { type: 'text', text: 'see-the-picture' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aaaa' } },
    ])
    await pictured
    const imageOnly = waitForTurnEnd(session)
    await session.prompt([{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,bbbb' } }])
    await imageOnly
    const history = JSON.stringify((await session.getContext()).history)
    expect(history).toContain('see-the-picture')
    expect(history).toContain('data:image/png;base64,aaaa')
    expect(history).toContain('data:image/png;base64,bbbb')
    expect(history).toContain('image_url')
    expect(history).not.toContain('[image attachment]')

    const exported = await harness.exportSession({ id: session.id, version: 'test' })
    expect(await zipText(exported.zipPath)).toContain(prompt)
    const sessionId = session.id
    await harness.close()

    const second = await startHarness(home)
    const resumed = await second.resumeSession({ id: sessionId })
    expect(JSON.stringify((await resumed.getContext()).history)).toBe(history)
    expect(second.capturedStderr()).toBe('')
  }, 60_000)

  it('creates a second session while a turn is running', async () => {
    const home = await tempDir('lmcode-desktop-home-')
    const work = await tempDir('lmcode-desktop-work-')
    const other = await tempDir('lmcode-desktop-other-')
    const harness = await startHarness(home)
    await harness.ensureConfigFile()
    const first = await harness.createSession({ workDir: work, model: 'script-bash' })
    let release: (response: { decision: 'approved' }) => void = () => undefined
    const approval = new Promise<void>((resolve) => {
      first.setApprovalHandler(() => {
        resolve()
        return new Promise((done) => {
          release = done
        })
      })
    })
    const ended = waitForTurnEnd(first)
    const running = first.prompt('run')
    await approval
    const second = await harness.createSession({
      workDir: other,
      model: 'script',
      permission: 'auto',
    })
    expect(second.id).not.toBe(first.id)
    await expect(second.getContext()).resolves.toEqual({ history: [] })
    const secondEnded = waitForTurnEnd(second)
    const secondRunning = second.prompt('hello')
    await secondRunning
    await expect(secondEnded).resolves.toEqual({ type: 'turn.ended', reason: 'completed' })
    await expect(second.getStatus()).resolves.toMatchObject({ model: 'script', permission: 'auto' })
    release({ decision: 'approved' })
    await running
    await expect(ended).resolves.toEqual({ type: 'turn.ended', reason: 'completed' })
  }, 60_000)

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
