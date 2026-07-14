import { describe, expect, it, vi } from 'vitest';

import { installSourceUpdate, manualUpdateCommand } from '#/cli/update/preflight';
import type { SourceProcessRunner, SourceUpdateCommand } from '#/cli/update/source-update';

describe('manualUpdateCommand', () => {
  it('uses the published package name for unsupported install layouts', () => {
    expect(manualUpdateCommand()).toBe('npm install -g @liumir/lmcode@latest');
  });
});

describe('installSourceUpdate', () => {
  it('surfaces a timed-out shared update step instead of blocking startup forever', async () => {
    const command: SourceUpdateCommand = {
      id: 'install',
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      timeoutMs: 25,
    };
    const runProcess = vi.fn(async () => ({
      outcome: 'timed-out' as const,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
    })) as SourceProcessRunner;

    await expect(installSourceUpdate('/repo', [command], runProcess)).rejects.toThrow(
      'pnpm 超时（25ms）',
    );
    expect(runProcess).toHaveBeenCalledWith(command, '/repo', { stdio: 'inherit' });
  });
});
