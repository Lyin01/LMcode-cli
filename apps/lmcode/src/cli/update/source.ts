/**
 * Detect whether the running CLI is installed from source (git clone).
 *
 * Source installs expose their checkout through `LMCODE_INSTALL_DIR`.
 * Legacy launchers used `LMCODE_HOME` for both code and data, so that path and
 * the historical `~/.lmcode` checkout remain supported as fallbacks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveLmcodeHome } from '@lmcode-cli/lmcode-sdk';

import { LMCODE_DATA_DIR_NAME, LMCODE_INSTALL_DIR_ENV } from '#/constant/app';

import { type InstallSource } from './types';

/**
 * Join path segments and normalize separators to `/`.
 *
 * `node:path.join` emits `\` on Windows, but install dirs are compared against
 * forward-slash paths (and the .git probe should be platform-independent), so
 * we normalize the result to keep behaviour consistent across platforms.
 */
function joinPosix(...segments: string[]): string {
  return join(...segments).replace(/\\/g, '/');
}

export interface DetectInstallSourceDeps {
  readonly getInstallDir: () => string;
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
}

const ROOT_PACKAGE_NAME = '@lmcode-cli/monorepo';
const APP_PACKAGE_NAME = '@liumir/lmcode';

function isPortableAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);
}

function packageName(filePath: string, read: (path: string) => string): string | undefined {
  try {
    const parsed = JSON.parse(read(filePath)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const name = (parsed as Record<string, unknown>)['name'];
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function isLmcodeCheckout(
  installDir: string,
  deps: Pick<DetectInstallSourceDeps, 'existsSync' | 'readFileSync'>,
): boolean {
  const rootPackagePath = joinPosix(installDir, 'package.json');
  const appPackagePath = joinPosix(installDir, 'apps', 'lmcode', 'package.json');
  return (
    deps.existsSync(joinPosix(installDir, '.git')) &&
    deps.existsSync(rootPackagePath) &&
    deps.existsSync(appPackagePath) &&
    packageName(rootPackagePath, deps.readFileSync) === ROOT_PACKAGE_NAME &&
    packageName(appPackagePath, deps.readFileSync) === APP_PACKAGE_NAME
  );
}

/**
 * Resolve the directory of a source (git clone) install, or `null` when the
 * running CLI was not installed from source.
 *
 * This is the single authority for *where* the install lives: the update
 * installer must run `git pull` / `pnpm` in the directory that was actually
 * detected, not a hardcoded `~/.lmcode`.
 */
export function resolveSourceInstallDir(
  deps: Partial<DetectInstallSourceDeps> = {},
): string | null {
  const resolved: DetectInstallSourceDeps = {
    getInstallDir:
      deps.getInstallDir ??
      (() => process.env[LMCODE_INSTALL_DIR_ENV] ?? resolveLmcodeHome()),
    existsSync: deps.existsSync ?? existsSync,
    readFileSync: deps.readFileSync ?? ((path) => readFileSync(path, 'utf-8')),
  };

  const rawInstallDir = resolved.getInstallDir().trim();
  if (rawInstallDir.length === 0 || !isPortableAbsolutePath(rawInstallDir)) return null;
  const installDir = joinPosix(rawInstallDir);

  // A .git directory alone is not sufficient: an empty or stale environment
  // variable could otherwise make /update run package scripts in an unrelated
  // repository. Verify both workspace manifests before trusting the checkout.
  if (isLmcodeCheckout(installDir, resolved)) {
    return installDir;
  }

  // Also recognise the legacy ~/.lmcode path even when LMCODE_HOME
  // points elsewhere (e.g. the user moved the env var but kept the default
  // clone location).
  const legacyDir = joinPosix(homedir(), LMCODE_DATA_DIR_NAME);
  if (legacyDir !== installDir && isLmcodeCheckout(legacyDir, resolved)) {
    return legacyDir;
  }

  return null;
}

export function detectInstallSource(
  deps: Partial<DetectInstallSourceDeps> = {},
): InstallSource {
  return resolveSourceInstallDir(deps) === null ? 'unsupported' : 'source';
}
