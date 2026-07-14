import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const shellInstaller = join(repoRoot, 'install.sh');
const powershellInstaller = join(repoRoot, 'install.ps1');

let testRoot: string;
let installDir: string;
let fakeBin: string;
let commandLog: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'lmcode-source-installer-'));
  installDir = join(testRoot, 'install with spaces');
  fakeBin = join(testRoot, 'fake bin');
  commandLog = join(testRoot, 'commands.log');
  mkdirSync(fakeBin, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function createCodeOnlyCheckout(): void {
  mkdirSync(join(installDir, '.git'), { recursive: true });
  writeFileSync(
    join(installDir, 'package.json'),
    JSON.stringify({ name: '@lmcode-cli/monorepo' }),
  );
  mkdirSync(join(installDir, 'apps', 'lmcode'), { recursive: true });
  writeFileSync(
    join(installDir, 'apps', 'lmcode', 'package.json'),
    JSON.stringify({ name: '@liumir/lmcode' }),
  );
  mkdirSync(join(installDir, 'plugins'), { recursive: true });
  writeFileSync(join(installDir, 'plugins', 'marketplace.json'), '{}');
}

function createCheckout(): string {
  createCodeOnlyCheckout();
  const sentinel = join(installDir, 'sessions', 'must-survive.jsonl');
  mkdirSync(join(installDir, 'sessions'), { recursive: true });
  writeFileSync(sentinel, 'user session data');
  return sentinel;
}

function createImpostorCheckout(): string {
  mkdirSync(join(installDir, '.git'), { recursive: true });
  mkdirSync(join(installDir, 'apps', 'lmcode'), { recursive: true });
  writeFileSync(
    join(installDir, 'apps', 'lmcode', 'package.json'),
    JSON.stringify({ name: '@liumir/lmcode' }),
  );
  const sentinel = join(installDir, 'keep.txt');
  writeFileSync(sentinel, 'keep me');
  return sentinel;
}

function createNestedNameImpostorCheckout(): string {
  mkdirSync(join(installDir, '.git'), { recursive: true });
  writeFileSync(
    join(installDir, 'package.json'),
    JSON.stringify({
      name: 'not-lmcode',
      nested: { name: '@lmcode-cli/monorepo' },
    }),
  );
  mkdirSync(join(installDir, 'apps', 'lmcode'), { recursive: true });
  writeFileSync(
    join(installDir, 'apps', 'lmcode', 'package.json'),
    JSON.stringify({
      name: 'not-lmcode-app',
      nested: { name: '@liumir/lmcode' },
    }),
  );
  const sentinel = join(installDir, 'keep.txt');
  writeFileSync(sentinel, 'keep me');
  return sentinel;
}

function childEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: testRoot,
    INSTALL_DIR: installDir,
    LMCODE_SKIP_PATH_UPDATE: '1',
    LMCODE_SKIP_SHORTCUT: '1',
    LMCODE_TEST_COMMAND_LOG: commandLog,
    PATH: `${fakeBin}${delimiter}${process.env['PATH'] ?? ''}`,
    SHELL: '/bin/bash',
  };
}

function writePosixCommand(name: string, body: string): void {
  const path = join(fakeBin, name);
  writeFileSync(path, `#!/usr/bin/env sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function preparePosixCommands(pnpmVersion = '11.7.0', includeCorepack = false): void {
  writePosixCommand(
    'git',
    `printf 'git' >> "$LMCODE_TEST_COMMAND_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LMCODE_TEST_COMMAND_LOG"; done
printf '\\n' >> "$LMCODE_TEST_COMMAND_LOG"
if [ "\${1:-}" = "--version" ]; then echo "git version 2.45.0"; fi
exit 0`,
  );
  writePosixCommand(
    'pnpm',
    `printf 'pnpm' >> "$LMCODE_TEST_COMMAND_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LMCODE_TEST_COMMAND_LOG"; done
printf '\\n' >> "$LMCODE_TEST_COMMAND_LOG"
if [ "\${1:-}" = "--version" ]; then echo "${pnpmVersion}"; fi
exit 0`,
  );
  if (includeCorepack) {
    writePosixCommand(
      'corepack',
      `printf 'corepack' >> "$LMCODE_TEST_COMMAND_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LMCODE_TEST_COMMAND_LOG"; done
printf '\n' >> "$LMCODE_TEST_COMMAND_LOG"
if [ "\${1:-}" = "pnpm" ] && [ "\${2:-}" = "--version" ]; then echo "11.7.0"; fi
exit 0`,
    );
  }
}

function writeWindowsCommand(name: string, pnpmVersion = '11.7.0'): void {
  const version = name === 'pnpm' ? pnpmVersion : `${name} version 11.7.0`;
  writeFileSync(
    join(fakeBin, `${name}.cmd`),
    `@echo off\r\necho ${name} %*>>"%LMCODE_TEST_COMMAND_LOG%"\r\n` +
      `if "%1"=="--version" echo ${version}\r\nexit /b 0\r\n`,
  );
}

function writeWindowsCorepack(): void {
  writeFileSync(
    join(fakeBin, 'corepack.cmd'),
    '@echo off\r\n' +
      'echo corepack %*>>"%LMCODE_TEST_COMMAND_LOG%"\r\n' +
      'if "%1"=="pnpm" if "%2"=="--version" echo 11.7.0\r\n' +
      'exit /b 0\r\n',
  );
}

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  it('updates a verified checkout without deleting user data or changing the launch cwd', () => {
    const sentinel = createCheckout();
    preparePosixCommands();

    const result = spawnSync('bash', [shellInstaller, '--upgrade'], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('user session data');
    const log = readFileSync(commandLog, 'utf8');
    expect(log).toContain(`git <-C> <${installDir}> <pull> <--ff-only> <origin> <main>`);
    expect(log).toContain(`pnpm <--dir> <${installDir}> <install> <--frozen-lockfile>`);
    expect(log).toContain(`pnpm <--dir> <${installDir}> <-r> <build>`);

    const launcher = readFileSync(join(installDir, 'bin', 'lm'), 'utf8');
    expect(launcher).toContain('LMCODE_INSTALL_DIR');
    expect(launcher).toContain('LMCODE_HOME');
    expect(launcher).not.toMatch(/^\s*cd\s/m);
  });

  it('keeps a fresh source install on the default user data directory', () => {
    preparePosixCommands();

    const result = spawnSync('bash', [shellInstaller], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const launcher = readFileSync(join(installDir, 'bin', 'lm'), 'utf8');
    expect(launcher).toContain('LMCODE_INSTALL_DIR');
    expect(launcher).not.toContain('LMCODE_HOME');
  });

  it('does not mistake tracked plugin metadata for legacy user data', () => {
    createCodeOnlyCheckout();
    preparePosixCommands();

    const result = spawnSync('bash', [shellInstaller, '--upgrade'], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const launcher = readFileSync(join(installDir, 'bin', 'lm'), 'utf8');
    expect(launcher).not.toContain('LMCODE_HOME');
  });

  it('uses pinned corepack pnpm when the installed pnpm is incompatible', () => {
    createCodeOnlyCheckout();
    preparePosixCommands('10.9.0', true);

    const result = spawnSync('bash', [shellInstaller, '--upgrade'], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(commandLog, 'utf8');
    expect(log).toContain('corepack <prepare> <pnpm@11.7.0> <--activate>');
    expect(log).toContain(`corepack <pnpm> <--dir> <${installDir}> <install> <--frozen-lockfile>`);
  });

  it('refuses to overwrite an existing non-LMcode directory even with --force', () => {
    const sentinel = createImpostorCheckout();
    preparePosixCommands();

    const result = spawnSync('bash', [shellInstaller, '--force'], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to overwrite existing non-LMcode directory');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep me');
    expect(existsSync(commandLog)).toBe(false);
  });

  it('requires the expected top-level manifest names before a forced update', () => {
    const sentinel = createNestedNameImpostorCheckout();
    preparePosixCommands();

    const result = spawnSync('bash', [shellInstaller, '--force'], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to overwrite existing non-LMcode directory');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep me');
    expect(existsSync(commandLog)).toBe(false);
  });

  it('rejects an install path that resolves to HOME', () => {
    installDir = `${testRoot}//`;
    createCodeOnlyCheckout();
    preparePosixCommands();

    const result = spawnSync('bash', [shellInstaller, '--force'], {
      encoding: 'utf8',
      env: childEnvironment(),
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing unsafe INSTALL_DIR');
    expect(existsSync(commandLog)).toBe(false);
  });

  it('shell-escapes the install bin directory before adding it to an rc file', () => {
    installDir = join(testRoot, 'install";touch injected;#');
    createCodeOnlyCheckout();
    preparePosixCommands();
    writeFileSync(join(testRoot, '.bashrc'), '');

    const env = childEnvironment();
    env['LMCODE_SKIP_PATH_UPDATE'] = '0';
    const result = spawnSync('bash', [shellInstaller, '--upgrade'], {
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const sourceResult = spawnSync('bash', ['-c', 'source "$HOME/.bashrc"'], {
      cwd: testRoot,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
    expect(sourceResult.status, sourceResult.stderr).toBe(0);
    expect(existsSync(join(testRoot, 'injected'))).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('install.ps1', () => {
  it('updates a verified checkout without deleting user data or changing the launch cwd', () => {
    const sentinel = createCheckout();
    writeWindowsCommand('git');
    writeWindowsCommand('pnpm');
    const powershell = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );

    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellInstaller, '--upgrade'],
      {
        encoding: 'utf8',
        env: childEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('user session data');
    const log = readFileSync(commandLog, 'utf8');
    expect(log).toContain(`git -C "${installDir}" pull --ff-only origin main`);
    expect(log).toContain(`pnpm --dir "${installDir}" install --frozen-lockfile`);
    expect(log).toContain(`pnpm --dir "${installDir}" -r build`);

    const launcher = readFileSync(join(installDir, 'bin', 'lm.cmd'), 'utf8');
    expect(launcher).toContain('LMCODE_INSTALL_DIR');
    expect(launcher).toContain('LMCODE_HOME');
    expect(launcher).not.toContain('cd /d');
  });

  it('keeps a fresh source install on the default user data directory', () => {
    writeWindowsCommand('git');
    writeWindowsCommand('pnpm');
    const powershell = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );

    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellInstaller],
      {
        encoding: 'utf8',
        env: childEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const launcher = readFileSync(join(installDir, 'bin', 'lm.cmd'), 'utf8');
    expect(launcher).toContain('LMCODE_INSTALL_DIR');
    expect(launcher).not.toContain('LMCODE_HOME');
  });

  it('does not mistake tracked plugin metadata for legacy user data', () => {
    createCodeOnlyCheckout();
    writeWindowsCommand('git');
    writeWindowsCommand('pnpm');
    const powershell = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );

    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellInstaller, '--upgrade'],
      {
        encoding: 'utf8',
        env: childEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const launcher = readFileSync(join(installDir, 'bin', 'lm.cmd'), 'utf8');
    expect(launcher).not.toContain('LMCODE_HOME');
  });

  it('uses pinned corepack pnpm when the installed pnpm is incompatible', () => {
    createCodeOnlyCheckout();
    writeWindowsCommand('git');
    writeWindowsCommand('pnpm', '10.9.0');
    writeWindowsCorepack();
    const powershell = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );

    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellInstaller, '--upgrade'],
      {
        encoding: 'utf8',
        env: childEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(commandLog, 'utf8');
    expect(log).toContain('corepack prepare pnpm@11.7.0 --activate');
    expect(log).toContain(`corepack pnpm --dir "${installDir}" install --frozen-lockfile`);
  });

  it('refuses to overwrite an existing non-LMcode directory even with --force', () => {
    const sentinel = createImpostorCheckout();
    writeWindowsCommand('git');
    writeWindowsCommand('pnpm');
    const powershell = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );

    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellInstaller, '--force'],
      {
        encoding: 'utf8',
        env: childEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Refusing to overwrite existing non-LMcode directory');
    expect(readFileSync(sentinel, 'utf8')).toBe('keep me');
    expect(existsSync(commandLog)).toBe(false);
  });

  it('escapes percent signs in generated batch launcher paths', () => {
    installDir = join(testRoot, 'install %USERPROFILE% with spaces');
    createCodeOnlyCheckout();
    writeWindowsCommand('git');
    writeWindowsCommand('pnpm');
    const powershell = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );

    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellInstaller, '--upgrade'],
      {
        encoding: 'utf8',
        env: childEnvironment(),
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const launcher = readFileSync(join(installDir, 'bin', 'lm.cmd'), 'utf8');
    expect(launcher.match(/%%USERPROFILE%%/g)).toHaveLength(2);
  });
});
