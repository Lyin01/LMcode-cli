/**
 * Detect whether the running CLI is installed from source (git clone).
 *
 * The only supported install method is `git clone` into ~/.lmcode
 * followed by `pnpm install && pnpm -r build`. All other layouts are
 * treated as "unsupported" for automatic updates.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveLmcodeHome } from '@lmcode-cli/lmcode-sdk';

import { LMCODE_DATA_DIR_NAME } from '#/constant/app';

import { type InstallSource } from './types';

export interface DetectInstallSourceDeps {
  readonly getInstallDir: () => string;
  readonly existsSync: (path: string) => boolean;
}

export function detectInstallSource(
  deps: Partial<DetectInstallSourceDeps> = {},
): InstallSource {
  const resolved: DetectInstallSourceDeps = {
    getInstallDir: deps.getInstallDir ?? (() => resolveLmcodeHome()),
    existsSync: deps.existsSync ?? existsSync,
  };

  const installDir = resolved.getInstallDir();

  // Source install is recognised when the install directory contains a .git
  // directory — this matches the layout produced by install.sh / install.ps1.
  if (resolved.existsSync(join(installDir, '.git'))) {
    return 'source';
  }

  // Also recognise the legacy ~/.lmcode path even when LMCODE_HOME
  // points elsewhere (e.g. the user moved the env var but kept the default
  // clone location).
  const legacyDir = join(homedir(), LMCODE_DATA_DIR_NAME);
  if (legacyDir !== installDir && resolved.existsSync(join(legacyDir, '.git'))) {
    return 'source';
  }

  return 'unsupported';
}
