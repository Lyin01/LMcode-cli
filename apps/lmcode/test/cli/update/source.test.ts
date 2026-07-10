import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { detectInstallSource, resolveSourceInstallDir } from '#/cli/update/source';

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
    // detectInstallSource normalizes separators to `/`, so build the expected
    // probe path the same way (homedir() uses `\` on Windows).
    const legacyGitDir = `${homedir().replace(/\\/g, '/')}/.lmcode/.git`;

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

describe('resolveSourceInstallDir', () => {
  it('returns the configured install dir when it contains .git', () => {
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => '/home/user/.lmcode',
        existsSync: (path: string) => path === '/home/user/.lmcode/.git',
      }),
    ).toBe('/home/user/.lmcode');
  });

  it('normalizes a Windows-style install dir to forward slashes', () => {
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => 'C:\\Users\\dev\\.lmcode',
        existsSync: (path: string) => path === 'C:/Users/dev/.lmcode/.git',
      }),
    ).toBe('C:/Users/dev/.lmcode');
  });

  it('falls back to the legacy ~/.lmcode clone when LMCODE_HOME points elsewhere', () => {
    const legacyDir = `${homedir().replace(/\\/g, '/')}/.lmcode`;
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => '/custom/path',
        existsSync: (path: string) => path === `${legacyDir}/.git`,
      }),
    ).toBe(legacyDir);
  });

  it('returns null when no source install exists', () => {
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => '/home/user/.lmcode',
        existsSync: () => false,
      }),
    ).toBeNull();
  });
});
