import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  spawnTargetForWindows,
  terminateProcessTree,
} from '#/utils/process/spawn-command';

describe('spawnTargetForWindows', () => {
  it('wraps pnpm (a .cmd shim on Windows) in cmd.exe /c', () => {
    const out = spawnTargetForWindows('pnpm', ['install'], 'win32');
    expect(out.cmd.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(out.args).toEqual(['/c', 'pnpm', 'install']);
  });

  it('preserves argv boundaries for multi-arg commands', () => {
    const out = spawnTargetForWindows('git', ['pull', 'origin', 'main'], 'win32');
    expect(out.args).toEqual(['/c', 'git', 'pull', 'origin', 'main']);
  });

  it('passes commands through unchanged on POSIX', () => {
    expect(spawnTargetForWindows('pnpm', ['install'], 'linux')).toEqual({
      cmd: 'pnpm',
      args: ['install'],
    });
  });
});

describe.skipIf(process.platform !== 'win32')('terminateProcessTree', () => {
  it('stops descendants before returning on Windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmcode-tree-kill-'));
    const childScript = join(dir, 'child.js');
    const commandScript = join(dir, 'start child.cmd');
    const ready = join(dir, 'descendant-started.txt');
    const marker = join(dir, 'descendant-survived.txt');
    await writeFile(
      childScript,
      [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.argv[2], 'ready');",
        "setTimeout(() => writeFileSync(process.argv[3], 'alive'), 1_200);",
      ].join('\n'),
    );
    await writeFile(
      commandScript,
      `@echo off\r\n"${process.execPath}" "${childScript}" "${ready}" "${marker}"\r\n`,
    );

    const child = spawn(
      process.env['ComSpec'] ?? 'cmd.exe',
      ['/d', '/s', '/c', `""${commandScript}""`],
      { stdio: 'ignore', windowsVerbatimArguments: true },
    );
    try {
      await once(child, 'spawn');
      await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
      await terminateProcessTree(child, 'win32');
      await sleep(1_300);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await terminateProcessTree(child, 'win32');
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
