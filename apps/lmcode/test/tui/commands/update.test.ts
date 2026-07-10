/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  refreshUpdateCache: vi.fn(),
  selectUpdateTarget: vi.fn(),
  resolveSourceInstallDir: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('#/cli/update/cache', () => ({ readUpdateCache: mocks.readUpdateCache }));
vi.mock('#/cli/update/refresh', () => ({ refreshUpdateCache: mocks.refreshUpdateCache }));
vi.mock('#/cli/update/select', () => ({ selectUpdateTarget: mocks.selectUpdateTarget }));
vi.mock('#/cli/update/source', () => ({
  resolveSourceInstallDir: mocks.resolveSourceInstallDir,
}));

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleUpdateCommand } from '#/tui/commands/update';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('handleUpdateCommand', () => {
  it('runs every source-update step through cmd.exe in the detected directory on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe');
    mocks.refreshUpdateCache.mockResolvedValue(undefined);
    mocks.readUpdateCache.mockResolvedValue({ latest: '0.9.9' });
    mocks.selectUpdateTarget.mockReturnValue({ version: '0.9.9' });
    mocks.resolveSourceInstallDir.mockReturnValue('E:/custom/lmcode');
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    });

    const showError = vi.fn();
    const showStatus = vi.fn();
    const setAppState = vi.fn();
    const host = {
      state: {
        appState: { streamingPhase: 'idle', version: '0.9.8' },
        theme: { colors: { success: '#00ff00' } },
      },
      showError,
      showStatus,
      setAppState,
    } as unknown as SlashCommandHost;

    await handleUpdateCommand(host);

    const spawnOptions = { cwd: 'E:/custom/lmcode', detached: false, stdio: 'pipe' };
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      'C:\\Windows\\System32\\cmd.exe',
      ['/c', 'git', 'pull', 'origin', 'main'],
      spawnOptions,
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\cmd.exe',
      ['/c', 'pnpm', 'install'],
      spawnOptions,
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      3,
      'C:\\Windows\\System32\\cmd.exe',
      ['/c', 'pnpm', '-r', 'build'],
      spawnOptions,
    );
    expect(showError).not.toHaveBeenCalled();
    expect(setAppState).toHaveBeenCalledWith({
      hasNewVersion: false,
      latestVersion: null,
    });
  });
});
