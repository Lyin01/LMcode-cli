/**
 * Process spawn and termination helpers.
 *
 * Windows command adaptation supports external commands with `shell: false`.
 * Node/libuv cannot execute the `.cmd`/`.bat` shims that npm-installed CLIs
 * resolve to (`npx`, `typescript-language-server`, `pyright-langserver`, …):
 * PATH lookup only appends `.exe`, never the PATHEXT shims, so
 * `spawn('npx')` fails with ENOENT on Windows. Wrapping the command in
 * `cmd.exe /c` lets PATHEXT resolution run. Direct `.exe` targets and every
 * non-Windows platform pass through unchanged.
 *
 * Shared by the MCP stdio client and the LSP client so the two spawn paths
 * cannot drift apart (a past `which`-vs-`where` divergence in the CLI came
 * from exactly this kind of copy).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const KILL_GRACE_MS = 100;
const PROCESS_TERMINATION_TIMEOUT_MS = 5_000;

/**
 * Map a Jian `Environment.osKind` ('Windows' | 'Linux' | 'macOS' | raw
 * platform string) to the NodeJS.Platform this module branches on. Use this
 * when the command will run inside a Jian, whose host OS may differ from the
 * local `process.platform`.
 */
export function platformFromOsKind(osKind: string): NodeJS.Platform {
  return osKind === 'Windows' ? 'win32' : 'linux';
}

/**
 * Adapt a command + args for spawning on Windows.
 *
 * Args are forwarded to `cmd.exe` without metacharacter escaping (`&`, `|`,
 * `<`, `>`, `^`); this mirrors common MCP-client behavior and is safe for the
 * usual command / flag / path arguments found in server configs.
 */
export function adaptSpawnCommandForWindows(
  command: string,
  args: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const argv = args === undefined ? [] : [...args];
  if (platform !== 'win32' || /\.exe$/i.test(command)) {
    return { command, args: argv };
  }
  const comspec = process.env['ComSpec'] ?? 'cmd.exe';
  return { command: comspec, args: ['/c', command, ...argv] };
}

/**
 * Terminate a spawned command and its descendants before returning.
 * POSIX callers must spawn the child with `detached: true` so its PID is also
 * the process-group ID; otherwise the fallback can only signal the direct child.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    killDirectly(child);
    await waitForChildClose(child);
    return;
  }

  if (platform === 'win32') {
    const killedTree = await runTaskkill(pid);
    if (!killedTree && !hasExited(child)) killDirectly(child);
    await waitForChildClose(child);
    return;
  }

  signalProcessGroup(child, pid, 'SIGTERM');
  await sleep(KILL_GRACE_MS);
  signalProcessGroup(child, pid, 'SIGKILL');
  await waitForChildClose(child);
}

function runTaskkill(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };
    killer.once('error', () => {
      finish(false);
    });
    killer.once('close', (code) => {
      finish(code === 0);
    });
    timeout = setTimeout(() => {
      killDirectly(killer);
      finish(false);
    }, PROCESS_TERMINATION_TIMEOUT_MS);
    timeout.unref();
  });
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Best effort: the process may already have exited.
    }
  }
}

function killDirectly(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // Best effort: the process may already have exited.
  }
}

async function waitForChildClose(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  let done!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    done = (): void => {
      resolve();
    };
    child.once('close', done);
    child.once('error', done);
  });
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, PROCESS_TERMINATION_TIMEOUT_MS);
    timeout.unref();
  });
  try {
    await Promise.race([closePromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    child.off('close', done);
    child.off('error', done);
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
