/**
 * Postinstall hook contract tests.
 *
 * The hook ships with the published package and runs on every install,
 * so its two invariants are load-bearing:
 *   1. Non-global contexts (npx, local deps, workspace bootstraps) are
 *      silent no-ops — no output, no filesystem side effects.
 *   2. Global installs patch the npm-generated `lm.ps1` shim for UTF-8
 *      (Windows) and respect the `LMCODE_NO_DESKTOP_SHORTCUT` opt-out.
 *
 * The scripts are plain `.mjs` consumed by Node at install time, so we
 * exercise them the way package managers do: as child processes with a
 * controlled environment (the test runner's own `npm_config_*`
 * lifecycle variables must not leak in).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const POSTINSTALL = path.join(SCRIPTS_DIR, 'postinstall.mjs');
const REACH = path.join(SCRIPTS_DIR, 'postinstall', 'reach.mjs');

/**
 * Minimal child env: keep what Node needs to start, drop every
 * npm/pnpm lifecycle variable the test runner itself sets.
 */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}

async function probeIsGlobalInstall(env: Record<string, string>): Promise<boolean> {
  const probe = `import(${JSON.stringify(pathToFileURL(REACH).href)}).then((m) => process.stdout.write(String(m.isGlobalInstall())));`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', probe],
    { env: cleanEnv(env) },
  );
  return stdout.trim() === 'true';
}

describe('isGlobalInstall', () => {
  it('is false in a clean lifecycle environment', async () => {
    expect(await probeIsGlobalInstall({})).toBe(false);
  });

  it('detects npm and pnpm global installs', async () => {
    expect(await probeIsGlobalInstall({ npm_config_global: 'true' })).toBe(true);
    expect(await probeIsGlobalInstall({ pnpm_config_global: 'true' })).toBe(true);
    expect(await probeIsGlobalInstall({ npm_config_location: 'global' })).toBe(true);
  });

  it('detects yarn classic `global add` via npm_config_argv', async () => {
    expect(
      await probeIsGlobalInstall({
        npm_config_user_agent: 'yarn/1.22.22 npm/? node/v22.0.0 win32 x64',
        npm_config_argv: JSON.stringify({ original: ['global', 'add', '@liumir/lmcode'] }),
      }),
    ).toBe(true);
  });

  it('rejects yarn classic local `add` and malformed argv', async () => {
    const ua = { npm_config_user_agent: 'yarn/1.22.22 npm/? node/v22.0.0 win32 x64' };
    expect(
      await probeIsGlobalInstall({
        ...ua,
        npm_config_argv: JSON.stringify({ original: ['add', '@liumir/lmcode'] }),
      }),
    ).toBe(false);
    expect(await probeIsGlobalInstall({ ...ua, npm_config_argv: '{not json' })).toBe(false);
  });
});

// A faithful copy of the npm cmd-shim `lm.ps1` skeleton — the patcher
// requires both the `$basedir=Split-Path` and `exit $ret` anchor lines.
const NPM_SHIM_TEMPLATE = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  '& "$basedir/node$exe" "$basedir/node_modules/@liumir/lmcode/dist/main.mjs" $args',
  '$ret=$LASTEXITCODE',
  'exit $ret',
  '',
].join('\n');

describe('postinstall.mjs', () => {
  let prefixDir: string;
  let shimPath: string;

  beforeEach(async () => {
    prefixDir = await mkdtemp(path.join(tmpdir(), 'lmcode-postinstall-'));
    shimPath = path.join(prefixDir, 'lm.ps1');
    await writeFile(shimPath, NPM_SHIM_TEMPLATE, 'utf8');
  });
  afterEach(async () => {
    await rm(prefixDir, { recursive: true, force: true });
  });

  function runPostinstall(extra: Record<string, string> = {}) {
    return execFileAsync(process.execPath, [POSTINSTALL], {
      env: cleanEnv({
        // Point the shim patcher at the sandbox; never at the real
        // global prefix. APPDATA is deliberately absent from cleanEnv
        // for the same reason.
        npm_config_prefix: prefixDir,
        LMCODE_NO_DESKTOP_SHORTCUT: '1',
        ...extra,
      }),
    });
  }

  it('is a silent no-op for non-global installs', async () => {
    const { stdout, stderr } = await runPostinstall();
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(await readFile(shimPath, 'utf8')).toBe(NPM_SHIM_TEMPLATE);
  });

  it('on global installs patches the lm.ps1 shim idempotently (win32)', async () => {
    await runPostinstall({ npm_config_global: 'true' });
    const once = await readFile(shimPath, 'utf8');
    if (process.platform !== 'win32') {
      expect(once).toBe(NPM_SHIM_TEMPLATE);
      return;
    }
    expect(once).toContain('# lmcode: force UTF-8');
    expect(once).toContain('exit $ret');
    await runPostinstall({ npm_config_global: 'true' });
    expect(await readFile(shimPath, 'utf8')).toBe(once);
  });

  it('leaves a shim that does not match the npm template untouched', async () => {
    const foreign = '# user-managed wrapper\n& lm.exe $args\n';
    await writeFile(shimPath, foreign, 'utf8');
    await runPostinstall({ npm_config_global: 'true' });
    expect(await readFile(shimPath, 'utf8')).toBe(foreign);
  });
});
