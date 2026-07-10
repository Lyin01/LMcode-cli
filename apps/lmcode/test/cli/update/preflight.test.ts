import { describe, expect, it } from 'vitest';

import { manualUpdateCommand, spawnTargetForWindows } from '#/cli/update/preflight';

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

describe('manualUpdateCommand', () => {
  it('points Windows users at install.ps1 (install.sh cannot run there)', () => {
    const cmd = manualUpdateCommand('win32');
    expect(cmd).toContain('install.ps1');
    expect(cmd).toContain('--upgrade');
    expect(cmd).not.toContain('install.sh');
  });

  it('points POSIX users at install.sh', () => {
    expect(manualUpdateCommand('linux')).toBe('cd ~/.lmcode && ./install.sh --upgrade');
    expect(manualUpdateCommand('darwin')).toBe('cd ~/.lmcode && ./install.sh --upgrade');
  });
});
