import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { JianProcess } from '@lmcode-cli/jian';

import { testJian } from '../fixtures/test-jian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';


const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('Session lifecycle hooks', () => {
  it('fires SessionStart on startup and SessionEnd on close', async () => {
    const { command, logPath, sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-123',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [
        { event: 'SessionStart', matcher: 'startup', command, timeout: 5 },
        { event: 'SessionEnd', matcher: 'exit', command, timeout: 5 },
      ],
    });

    await session.createMain();
    await session.close();

    expect(await readHookPayloads(logPath)).toMatchObject([
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-123',
        cwd: workDir,
        source: 'startup',
      },
      {
        hook_event_name: 'SessionEnd',
        session_id: 'session-123',
        cwd: workDir,
        reason: 'exit',
      },
    ]);
  });

  it('fires SessionStart with resume source after loading metadata', async () => {
    const { command, logPath, sessionDir, workDir } = await hookFixture();
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        title: 'Resumed Session',
        isCustomTitle: false,
        agents: {},
        custom: {},
      }),
      'utf-8',
    );
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-456',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [{ event: 'SessionStart', matcher: 'resume', command, timeout: 5 }],
    });

    await session.resume();

    expect(await readHookPayloads(logPath)).toMatchObject([
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-456',
        cwd: workDir,
        source: 'resume',
      },
    ]);
  });

  it('does not let failing SessionStart or SessionEnd hook commands interrupt startup or close', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-reject',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      hooks: [
        { event: 'SessionStart', matcher: 'startup', command: 'exit 1', timeout: 5 },
        { event: 'SessionEnd', matcher: 'exit', command: 'exit 1', timeout: 5 },
      ],
    });

    await expect(session.createMain()).resolves.toBeDefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('stops background tasks on close when keepAliveOnExit is false', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-bg-cleanup',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: false },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.register(proc, 'sleep 60', 'exit cleanup');

    await session.close();

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(agent.background.getTask(taskId)?.status).toBe('killed');
  });

  it('lets the environment override config when deciding background task cleanup', async () => {
    vi.stubEnv('LMCODE_BACKGROUND_KEEP_ALIVE_ON_EXIT', '0');
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-bg-env-cleanup',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      background: { keepAliveOnExit: true },
    });
    const agent = await session.createMain();
    const { proc, killSpy } = pendingProcess();
    const taskId = agent.background.register(proc, 'sleep 60', 'env cleanup');

    await session.close();

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(agent.background.getTask(taskId)?.status).toBe('killed');
  });

  it('waits for a cancelled active turn to settle before closing agent resources', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-active-turn-close',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();
    let resolveTurn!: (value: {
      event: { type: 'turn.ended'; turnId: number; reason: 'cancelled' };
    }) => void;
    const activeTurn = new Promise<{
      event: { type: 'turn.ended'; turnId: number; reason: 'cancelled' };
    }>((resolve) => {
      resolveTurn = resolve;
    });
    vi.spyOn(agent.turn, 'hasActiveTurn', 'get').mockReturnValue(true);
    vi.spyOn(agent.turn, 'waitForCurrentTurn').mockReturnValue(activeTurn);
    const stopCron = vi.spyOn(agent.cron!, 'stop');
    const cancel = vi.spyOn(agent.turn, 'cancel').mockImplementation(() => {});
    const closeAgent = vi.spyOn(agent, 'close');

    const closing = session.close();
    const concurrentClose = session.close();
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
    });
    expect(stopCron).toHaveBeenCalledTimes(1);
    expect(stopCron.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]!);
    expect(closeAgent).not.toHaveBeenCalled();

    resolveTurn({
      event: { type: 'turn.ended', turnId: 1, reason: 'cancelled' },
    });
    await Promise.all([closing, concurrentClose]);

    expect(closeAgent).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('continues closing after an active turn ignores cancellation for five seconds', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-active-turn-timeout',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();
    vi.spyOn(agent.turn, 'hasActiveTurn', 'get').mockReturnValue(true);
    vi.spyOn(agent.turn, 'waitForCurrentTurn').mockReturnValue(new Promise(() => {}));
    const cancel = vi.spyOn(agent.turn, 'cancel').mockImplementation(() => {});
    const closeAgent = vi.spyOn(agent, 'close');

    vi.useFakeTimers();
    try {
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(closeAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closeAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects metadata, MCP, and agent RPC operations once close starts', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-rpc-closed',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await session.createMain();
    const api = new SessionAPIImpl(session);

    const closing = session.close();

    expect(() => api.getSessionMetadata({})).toThrowError(
      expect.objectContaining({ code: 'session.closed' }),
    );
    expect(() => api.listMcpServers({})).toThrowError(
      expect.objectContaining({ code: 'session.closed' }),
    );
    expect(() => api.getModel({ agentId: 'main' })).toThrowError(
      expect.objectContaining({ code: 'session.closed' }),
    );
    await expect(api.renameSession({ title: 'late rename' })).rejects.toMatchObject({
      code: 'session.closed',
    });
    await closing;
    expect(() => api.getModel({ agentId: 'main' })).toThrowError(
      expect.objectContaining({ code: 'session.closed' }),
    );
  });

  it('does not launch a prompt after close overtakes its metadata write', async () => {
    const { sessionDir, workDir } = await hookFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-prompt-close-race',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const agent = await session.createMain();
    await session.flushMetadata();
    const api = new SessionAPIImpl(session);
    const metadataWrite = deferred<void>();
    const writeMetadata = vi
      .spyOn(session, 'writeMetadata')
      .mockImplementationOnce(() => metadataWrite.promise);
    const launchTurn = vi.spyOn(agent.turn, 'prompt');

    const prompting = api.prompt({
      agentId: 'main',
      input: [{ type: 'text', text: 'must not start after close' }],
    });
    const rejection = expect(prompting).rejects.toMatchObject({ code: 'session.closed' });
    await vi.waitFor(() => {
      expect(writeMetadata).toHaveBeenCalledTimes(1);
    });

    await session.close();
    metadataWrite.resolve();
    await rejection;

    expect(launchTurn).not.toHaveBeenCalled();
  });
});

async function hookFixture(): Promise<{
  readonly command: string;
  readonly logPath: string;
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const dir = await makeTempDir();
  const workDir = join(dir, 'work');
  const sessionDir = join(dir, 'session');
  const logPath = join(dir, 'hooks.jsonl');
  const scriptPath = join(dir, 'record-hook.cjs');
  await mkdir(join(workDir, '.git'), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    scriptPath,
    [
      "const { appendFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { appendFileSync(process.argv[2], `${input.trim()}\\n`); });",
      '',
    ].join('\n'),
    'utf-8',
  );
  return {
    command: `node ${JSON.stringify(scriptPath)} ${JSON.stringify(logPath)}`,
    logPath,
    sessionDir,
    workDir,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lmcode-session-hooks-'));
  tempDirs.push(dir);
  return dir;
}

async function readHookPayloads(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, 'utf-8');
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pendingProcess(exitOnKill = 143): {
  readonly proc: JianProcess;
  readonly killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode !== null) return;
    currentExitCode = exitOnKill;
    resolveWait(exitOnKill);
  });
  const proc: JianProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54_321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as JianProcess['kill'],
  };
  return { proc, killSpy };
}
