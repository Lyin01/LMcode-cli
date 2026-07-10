import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  checkPosixProcessCommandLine,
  checkWindowsProcessCommandLine,
} from '#/tui/utils/cc-connect-status';
import { terminateProcessTree } from '#/utils/process/spawn-command';

const checkProcessCommandLine =
  process.platform === 'win32'
    ? checkWindowsProcessCommandLine
    : checkPosixProcessCommandLine;

describe.skipIf(!['darwin', 'linux', 'win32'].includes(process.platform))(
  'cc-connect process status',
  () => {
    it('ignores the probe tree and detects a matching unmanaged process', async () => {
      const needle = `lmcode-cc-status-${String(process.pid)}-${String(Date.now())}`;
      await expect(checkProcessCommandLine(needle)).resolves.toBe(false);

      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1_000)', needle],
        { stdio: 'ignore', windowsHide: true },
      );
      try {
        await once(child, 'spawn');
        await expect
          .poll(() => checkProcessCommandLine(needle), {
            timeout: 10_000,
            interval: 250,
          })
          .toBe(true);
      } finally {
        await stopChild(child);
      }
    }, 15_000);
  },
);

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await terminateProcessTree(child, 'win32');
    return;
  }
  const closePromise = once(child, 'close');
  child.kill('SIGKILL');
  await closePromise;
}
