import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { adaptSpawnCommandForWindows, platformFromOsKind, terminateProcessTreeByPid } from '../../src/utils/spawn-command';

describe('adaptSpawnCommandForWindows', () => {
  it('wraps a .cmd/npx-style command in cmd.exe /c on Windows', () => {
    const out = adaptSpawnCommandForWindows('npx', ['-y', '@scope/server'], 'win32');
    expect(out.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(out.args).toEqual(['/c', 'npx', '-y', '@scope/server']);
  });

  it('wraps npm-shim language servers the same way', () => {
    const out = adaptSpawnCommandForWindows('typescript-language-server', ['--stdio'], 'win32');
    expect(out.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(out.args).toEqual(['/c', 'typescript-language-server', '--stdio']);
  });

  it('passes a direct .exe target through unchanged on Windows', () => {
    const out = adaptSpawnCommandForWindows('C:/tools/server.EXE', ['--stdio'], 'win32');
    expect(out).toEqual({ command: 'C:/tools/server.EXE', args: ['--stdio'] });
  });

  it('does not wrap on non-Windows platforms', () => {
    expect(adaptSpawnCommandForWindows('npx', ['-y', 'server'], 'linux')).toEqual({
      command: 'npx',
      args: ['-y', 'server'],
    });
  });

  it('tolerates undefined args', () => {
    expect(adaptSpawnCommandForWindows('npx', undefined, 'linux')).toEqual({
      command: 'npx',
      args: [],
    });
    expect(adaptSpawnCommandForWindows('npx', undefined, 'win32').args).toEqual(['/c', 'npx']);
  });
});

describe('platformFromOsKind', () => {
  it('maps a Windows jian host to win32', () => {
    expect(platformFromOsKind('Windows')).toBe('win32');
  });

  it('maps every non-Windows host to a POSIX platform', () => {
    expect(platformFromOsKind('Linux')).toBe('linux');
    expect(platformFromOsKind('macOS')).toBe('linux');
    expect(platformFromOsKind('freebsd')).toBe('linux');
  });
});

describe('terminateProcessTreeByPid', () => {
  it('is a no-op on non-Windows platforms', async () => {
    await expect(terminateProcessTreeByPid(999999, 'linux')).resolves.toBe(false);
  });

  it.runIf(process.platform === 'win32')('terminates a live process by pid', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error('failed to spawn the probe process');

      await expect(terminateProcessTreeByPid(pid)).resolves.toBe(true);

      const deadline = Date.now() + 10000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(alive).toBe(false);
    } finally {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  });
});
