import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { PROCESS_TREE_TERMINATION_TIMEOUT_MS } from '#/constant/process';

export interface SpawnTarget {
  readonly cmd: string;
  readonly args: string[];
}

/**
 * Windows resolves npm-installed commands through .cmd shims. A shell-less
 * spawn cannot execute those shims, so route non-.exe commands through cmd.exe
 * while preserving each argument as a separate argv entry.
 */
export function spawnTargetForWindows(
  cmd: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== 'win32' || /\.exe$/i.test(cmd)) {
    return { cmd, args: [...args] };
  }
  return { cmd: process.env['ComSpec'] ?? 'cmd.exe', args: ['/c', cmd, ...args] };
}

/** Terminate a spawned command and its descendants, then wait for it to close. */
export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (hasExited(child)) return;
  const closePromise = waitForClose(child);
  if (hasExited(child)) {
    await closePromise;
    return;
  }
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    killDirectly(child);
    await closePromise;
    return;
  }

  if (platform === 'win32') {
    const killedTree = await runTaskkill(pid);
    if (!killedTree && !hasExited(child)) killDirectly(child);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && !hasExited(child)) killDirectly(child);
    }
  }

  await closePromise;
}

async function runTaskkill(pid: number): Promise<boolean> {
  const killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(pid)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const completion = new Promise<boolean>((resolve) => {
    killer.once('error', () => {
      resolve(false);
    });
    killer.once('close', (code) => {
      resolve(code === 0);
    });
  });
  let timeoutId!: NodeJS.Timeout;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => {
      killDirectly(killer);
      resolve(false);
    }, PROCESS_TREE_TERMINATION_TIMEOUT_MS);
    timeoutId.unref();
  });
  try {
    return await Promise.race([completion, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function killDirectly(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // Best effort: the process may already have exited.
  }
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;

  let done!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    done = (): void => {
      resolve();
    };
    child.once('close', done);
    child.once('error', done);
  });
  try {
    await Promise.race([
      closePromise,
      sleep(PROCESS_TREE_TERMINATION_TIMEOUT_MS, undefined, { ref: false }),
    ]);
  } finally {
    child.off('close', done);
    child.off('error', done);
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
