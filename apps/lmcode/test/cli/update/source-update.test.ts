import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pnpmVersionIsCompatible,
  resolvePnpmCommand,
  resolveSourceUpdateCommands,
  runSourceProcess,
  type SourceProcessResult,
  type SourceProcessRunner,
} from '#/cli/update/source-update';

function result(stdout: string, outcome: SourceProcessResult['outcome'] = 'success'): SourceProcessResult {
  return {
    outcome,
    exitCode: outcome === 'success' ? 0 : 1,
    signal: null,
    stdout,
    stderr: '',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('source update pnpm selection', () => {
  it('accepts only the installer-supported pnpm range', () => {
    expect(pnpmVersionIsCompatible('11.7.0')).toBe(true);
    expect(pnpmVersionIsCompatible('11.12.3')).toBe(true);
    expect(pnpmVersionIsCompatible('11.6.9')).toBe(false);
    expect(pnpmVersionIsCompatible('11.7.0-rc.1')).toBe(false);
    expect(pnpmVersionIsCompatible('10.9.0')).toBe(false);
    expect(pnpmVersionIsCompatible('12.0.0')).toBe(false);
    expect(pnpmVersionIsCompatible('unknown')).toBe(false);
  });

  it('uses pinned corepack pnpm when the installed pnpm is incompatible', async () => {
    const calls: string[] = [];
    const runProcess: SourceProcessRunner = async (invocation) => {
      calls.push([invocation.cmd, ...invocation.args].join(' '));
      if (invocation.cmd === 'pnpm') return result('10.9.0');
      if (invocation.args[0] === 'prepare') return result('');
      return result('11.7.0');
    };

    const command = await resolvePnpmCommand('/repo', { runProcess });
    const commands = await resolveSourceUpdateCommands('/repo', { runProcess });

    expect(command).toEqual({ cmd: 'corepack', argsPrefix: ['pnpm'] });
    expect(commands[1]).toMatchObject({
      cmd: 'corepack',
      args: ['pnpm', 'install', '--frozen-lockfile'],
    });
    expect(calls).toContain('corepack prepare pnpm@11.7.0 --activate');
  });

  it('keeps a compatible installed pnpm without invoking corepack', async () => {
    const runProcess = vi.fn(async () => result('11.8.0'));

    await expect(resolvePnpmCommand('/repo', { runProcess })).resolves.toEqual({
      cmd: 'pnpm',
      argsPrefix: [],
    });
    expect(runProcess).toHaveBeenCalledOnce();
  });
});

describe('source update process timeout', () => {
  it('terminates the spawned process tree before reporting a timeout', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      pid: 123,
      kill: vi.fn(),
    });
    const spawnCommand = vi.fn(() => child as never);
    const terminate = vi.fn(async () => undefined);

    const execution = runSourceProcess(
      { cmd: 'pnpm', args: ['install'], timeoutMs: 50 },
      '/repo',
      { spawnCommand: spawnCommand as never, terminate },
    );
    await vi.advanceTimersByTimeAsync(50);

    await expect(execution).resolves.toMatchObject({ outcome: 'timed-out' });
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it('still resolves a timeout when process-tree cleanup fails', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      pid: 456,
      kill: vi.fn(),
    });
    const cleanupError = new Error('taskkill failed');
    const execution = runSourceProcess(
      { cmd: 'pnpm', args: ['install'], timeoutMs: 50 },
      '/repo',
      {
        spawnCommand: vi.fn(() => child as never) as never,
        terminate: vi.fn(async () => Promise.reject(cleanupError)),
      },
    );
    await vi.advanceTimersByTimeAsync(50);

    await expect(execution).resolves.toMatchObject({
      outcome: 'timed-out',
      errorMessage: cleanupError.message,
    });
  });
});
