import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

const RUNNER_MODULE = '../../src/session/hooks/runner' as string;

interface HookResult {
  action: 'allow' | 'block';
  message?: string;
  reason?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  structuredOutput?: boolean;
}

interface ProcessTreeFixture {
  readonly dir: string;
  readonly command: string;
  readonly pidFile: string;
}

type RunHook = (
  command: string,
  input: Record<string, unknown>,
  options: { timeout: number; cwd?: string; signal?: AbortSignal },
) => Promise<HookResult>;

async function importRunHook(): Promise<RunHook> {
  const mod = (await import(RUNNER_MODULE)) as { runHook: RunHook };
  return mod.runHook;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const runHook = await importRunHook();
    const result = await runHook('echo ok', { tool_name: 'Shell' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const runHook = await importRunHook();
    const result = await runHook('echo \'{"message":"hook says hi"}\'', {}, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('marks structured stdout JSON without message as empty hook output', async () => {
    const runHook = await importRunHook();

    const emptyObject = await runHook("echo '{}'", {}, { timeout: 5 });
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBe(true);

    const emptyHookSpecificOutput = await runHook(
      'echo \'{"hookSpecificOutput":{}}\'',
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      "echo 'blocked' >&2; exit 2",
      { tool_name: 'Shell' },
      { timeout: 5 },
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes (e.g. exit 1)', async () => {
    const runHook = await importRunHook();
    const result = await runHook('exit 1', { tool_name: 'Shell' }, { timeout: 5 });
    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut=true when the command exceeds the timeout', async () => {
    const runHook = await importRunHook();
    const result = await runHook('sleep 10', { tool_name: 'Shell' }, { timeout: 1 });
    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('terminates hook descendants before returning a timeout result', async () => {
    const runHook = await importRunHook();
    const fixture = await createProcessTreeFixture('lmcode-hook-timeout-tree-');
    const resultPromise = runHook(fixture.command, {}, { timeout: 3, cwd: fixture.dir });

    let descendantPid: number | undefined;
    try {
      const pid = await waitForPidFile(fixture.pidFile);
      descendantPid = pid;
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      await expect.poll(() => isProcessAlive(pid), { timeout: 2_000 }).toBe(false);
    } finally {
      await resultPromise;
      await cleanupProcessTreeFixture(fixture, descendantPid);
    }
  }, 10_000);

  it('terminates hook descendants before returning an abort result', async () => {
    const runHook = await importRunHook();
    const fixture = await createProcessTreeFixture('lmcode-hook-abort-tree-');
    const controller = new AbortController();
    const resultPromise = runHook(fixture.command, {}, {
      timeout: 5,
      cwd: fixture.dir,
      signal: controller.signal,
    });

    let descendantPid: number | undefined;
    try {
      const pid = await waitForPidFile(fixture.pidFile);
      descendantPid = pid;
      controller.abort();
      const result = await resultPromise;

      expect(result.action).toBe('allow');
      expect(result.timedOut).toBeUndefined();
      expect(result.exitCode).toBeUndefined();
      await expect.poll(() => isProcessAlive(pid), { timeout: 2_000 }).toBe(false);
    } finally {
      controller.abort();
      await resultPromise;
      await cleanupProcessTreeFixture(fixture, descendantPid);
    }
  }, 10_000);

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const runHook = await importRunHook();
    const cmd =
      'echo \'{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "use rg"}}\'';
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const runHook = await importRunHook();
    const cmd =
      'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);process.stdout.write(o.tool_name);})"';
    const result = await runHook(cmd, { tool_name: 'WriteFile' }, { timeout: 5 });
    expect(result.stdout?.trim()).toBe('WriteFile');
  });
});

async function createProcessTreeFixture(prefix: string): Promise<ProcessTreeFixture> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const script = join(dir, 'long-running-descendant.cjs');
  const pidFile = join(dir, 'descendant.pid');
  await writeFile(
    script,
    [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.argv[2], String(process.pid));",
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
  return {
    dir,
    command: `"${process.execPath}" "${script}" "${pidFile}"`,
    pidFile,
  };
}

async function cleanupProcessTreeFixture(
  fixture: ProcessTreeFixture,
  descendantPid: number | undefined,
): Promise<void> {
  if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
    try {
      process.kill(descendantPid, 'SIGKILL');
    } catch {
      // The fixed runner has already reaped it.
    }
    if (!(await waitForProcessExit(descendantPid))) {
      throw new Error(`Hook descendant ${String(descendantPid)} survived test cleanup`);
    }
  }
  await rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function waitForPidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The descendant has not written its PID yet.
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for hook descendant PID at ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(pid)) return true;
    await sleep(20);
  }
  return false;
}
