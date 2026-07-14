import { homedir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectInstallSource,
  type DetectInstallSourceDeps,
  resolveSourceInstallDir,
} from '#/cli/update/source';

afterEach(() => {
  vi.unstubAllEnvs();
});

function lmcodeCheckout(
  installDir: string,
): Pick<DetectInstallSourceDeps, 'existsSync' | 'readFileSync'> {
  const normalized = installDir.replace(/\\/g, '/');
  const rootPackage = `${normalized}/package.json`;
  const appPackage = `${normalized}/apps/lmcode/package.json`;
  const paths = new Set([`${normalized}/.git`, rootPackage, appPackage]);
  return {
    existsSync: (path) => paths.has(path),
    readFileSync: (path) =>
      JSON.stringify({
        name: path === rootPackage ? '@lmcode-cli/monorepo' : '@liumir/lmcode',
      }),
  };
}

describe('detectInstallSource', () => {
  it('returns source for a checkout with the LMcode workspace manifests', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.lmcode',
        ...lmcodeCheckout('/home/user/.lmcode'),
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
        ...lmcodeCheckout(legacyGitDir.slice(0, -'/.git'.length)),
      }),
    ).toBe('source');
  });

  it('rejects an unrelated git repository', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/unrelated',
        existsSync: (path) => path === '/home/user/unrelated/.git',
        readFileSync: () => JSON.stringify({ name: 'unrelated-project' }),
      }),
    ).toBe('unsupported');
  });

  it('rejects empty and relative install directory values', () => {
    for (const installDir of ['', '.', './other-repo']) {
      expect(
        detectInstallSource({
          getInstallDir: () => installDir,
          existsSync: () => true,
          readFileSync: () => JSON.stringify({ name: '@lmcode-cli/monorepo' }),
        }),
      ).toBe('unsupported');
    }
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
  it('prefers the source checkout exported by the installer launcher', () => {
    vi.stubEnv('LMCODE_INSTALL_DIR', '/opt/lmcode-source');

    expect(
      resolveSourceInstallDir({
        ...lmcodeCheckout('/opt/lmcode-source'),
      }),
    ).toBe('/opt/lmcode-source');
  });

  it('returns the configured install dir when it contains .git', () => {
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => '/home/user/.lmcode',
        ...lmcodeCheckout('/home/user/.lmcode'),
      }),
    ).toBe('/home/user/.lmcode');
  });

  it('normalizes a Windows-style install dir to forward slashes', () => {
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => 'C:\\Users\\dev\\.lmcode',
        ...lmcodeCheckout('C:/Users/dev/.lmcode'),
      }),
    ).toBe('C:/Users/dev/.lmcode');
  });

  it('falls back to the legacy ~/.lmcode clone when LMCODE_HOME points elsewhere', () => {
    const legacyDir = `${homedir().replace(/\\/g, '/')}/.lmcode`;
    expect(
      resolveSourceInstallDir({
        getInstallDir: () => '/custom/path',
        ...lmcodeCheckout(legacyDir),
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
