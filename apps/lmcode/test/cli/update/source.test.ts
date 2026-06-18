import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { detectInstallSource } from '#/cli/update/source';

describe('detectInstallSource', () => {
  it('returns source when the install directory contains a .git directory', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.lmcode',
        existsSync: (path: string) => path === '/home/user/.lmcode/.git',
      }),
    ).toBe('source');
  });

  it('returns source for the legacy ~/.lmcode path even when LMCODE_HOME points elsewhere', () => {
    const legacyGitDir = `${homedir()}/.lmcode/.git`;

    expect(
      detectInstallSource({
        getInstallDir: () => '/custom/path',
        existsSync: (path: string) => path === legacyGitDir,
      }),
    ).toBe('source');
  });

  it('returns unsupported when no .git directory is found', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.lmcode',
        existsSync: () => false,
      }),
    ).toBe('unsupported');
  });

  it('returns unsupported when only the install dir exists without .git', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.lmcode',
        existsSync: (path: string) => path === '/home/user/.lmcode',
      }),
    ).toBe('unsupported');
  });
});
