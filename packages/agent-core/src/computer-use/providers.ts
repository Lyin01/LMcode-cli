import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type {
  ComputerUsePermissionMode,
  ComputerUseProviderDescriptor,
  ComputerUseProviderId,
} from './types';

/** Provider used when neither config nor the UI selects one explicitly. */
export const DEFAULT_COMPUTER_USE_PROVIDER_ID: ComputerUseProviderId = 'cua-driver-mcp';

/** Permission mode applied when the operator does not choose one. */
export const DEFAULT_COMPUTER_USE_PERMISSION_MODE: ComputerUsePermissionMode = 'standard';

/** Environment variable the driver reads to fix its permission mode at launch. */
export const COMPUTER_USE_PERMISSION_MODE_ENV = 'CUA_DRIVER_PERMISSION_MODE';

const PROVIDER_DESCRIPTORS: Record<ComputerUseProviderId, ComputerUseProviderDescriptor> = {
  'cua-driver-mcp': {
    id: 'cua-driver-mcp',
    label: 'Cua Driver (MCP)',
    serverName: 'cua-driver-mcp',
    toolNamePrefix: 'mcp__cua-driver-mcp__',
    defaultCommand: 'cua-driver',
    defaultArgs: ['mcp'],
    docsUrl: 'https://cua.ai/docs/how-to-guides/driver/connect-your-agent',
  },
};

/** How to obtain the provider's driver on the host platform. */
export interface ComputerUseInstallRecipe {
  /** Executable that runs the vendor installer. */
  readonly program: string;
  /** Arguments that install without an interactive prompt. */
  readonly args: readonly string[];
  /** Equivalent command the operator can paste into a shell themselves. */
  readonly manualCommand: string;
}

export function computerUseProviders(): readonly ComputerUseProviderDescriptor[] {
  return Object.values(PROVIDER_DESCRIPTORS);
}

export function computerUseProvider(id: string): ComputerUseProviderDescriptor | undefined {
  return Object.hasOwn(PROVIDER_DESCRIPTORS, id)
    ? PROVIDER_DESCRIPTORS[id as ComputerUseProviderId]
    : undefined;
}

export function isComputerUseProviderId(value: string): value is ComputerUseProviderId {
  return Object.hasOwn(PROVIDER_DESCRIPTORS, value);
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/**
 * Absolute locations the vendor installer is known to use, most-preferred
 * first. Detection uses these before falling back to PATH lookup, because a
 * freshly installed driver is not visible to PATH inside an already-running
 * process.
 */
export function computerUseDriverCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): readonly string[] {
  const candidates: string[] = [];
  if (isWindows(platform)) {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.length > 0) {
      candidates.push(path.join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'));
      // Pre-v0.2.14 vendor folder; the installer migrates it, so this only
      // matters for an install that has not been launched since the rename.
      candidates.push(
        path.join(localAppData, 'Programs', 'trycua', 'cua-driver-rs', 'bin', 'cua-driver.exe'),
      );
    }
  } else {
    const home = env['HOME'];
    // Best-effort hints for the vendor's documented install layouts; PATH
    // resolution below remains the authoritative fallback.
    if (home !== undefined && home.length > 0) {
      candidates.push(path.join(home, '.local', 'bin', 'cua-driver'));
    }
    candidates.push('/usr/local/bin/cua-driver', '/opt/homebrew/bin/cua-driver');
  }
  return candidates;
}

/**
 * First existing driver path for this platform, or `undefined` when only PATH
 * lookup can resolve it.
 */
export function detectComputerUseDriver(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined {
  return computerUseDriverCandidates(platform, env).find((candidate) => exists(candidate));
}

function looksLikePath(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/**
 * Turn the configured command into something spawnable.
 *
 * An explicit path is honoured as given. The bare default command is upgraded
 * to a detected absolute path when one exists, which is what makes a
 * just-installed driver usable without restarting the host application.
 */
export function resolveComputerUseCommand(
  command: string,
  descriptor: ComputerUseProviderDescriptor,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (candidate: string) => boolean = existsSync,
): string {
  if (looksLikePath(command) || command !== descriptor.defaultCommand) return command;
  return detectComputerUseDriver(platform, env, exists) ?? command;
}

/** Vendor install recipe for the host platform. */
export function computerUseInstallRecipe(
  platform: NodeJS.Platform,
): ComputerUseInstallRecipe | undefined {
  if (isWindows(platform)) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$installer = Join-Path $env:TEMP 'cua-driver-install.ps1'",
      "Invoke-WebRequest -UseBasicParsing -Uri 'https://cua.ai/driver/install.ps1' -OutFile $installer",
      // The vendor installer registers a logon Scheduled Task by default. The
      // driver serves MCP from its own process, so the capability does not
      // need a persistent daemon: suppress the task and leave that decision
      // to the operator.
      '& $installer -NoAutoStart',
    ].join('; ');
    return {
      program: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      manualCommand: 'irm https://cua.ai/driver/install.ps1 | iex',
    };
  }
  return {
    program: 'bash',
    args: ['-c', 'curl -fsSL https://cua.ai/driver/install.sh | bash'],
    manualCommand: '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"',
  };
}
