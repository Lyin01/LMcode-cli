/**
 * Scream host and device identity header factories.
 *
 * The caller owns the host identity (product name + host app version)
 * and the `homeDir` where the stable device id is stored. This module
 * intentionally keeps no global CLI version or environment-derived
 * production state.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, hostname, release, type } from 'node:os';
import { join } from 'node:path';

export const LMCODE_PLATFORM = 'lmcode_cli';

/** Device identification for `X-Msh-*` headers. */
export interface DeviceHeaders {
  readonly 'X-Msh-Platform': string;
  readonly 'X-Msh-Version': string;
  readonly 'X-Msh-Device-Name': string;
  readonly 'X-Msh-Device-Model': string;
  readonly 'X-Msh-Os-Version': string;
  readonly 'X-Msh-Device-Id': string;
}

export interface LmcodeHostIdentity {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}

export interface LmcodeIdentityOptions extends LmcodeHostIdentity {
  readonly homeDir: string;
}

export interface CreateScreamDeviceIdOptions {}

export function createLmcodeDeviceId(
  homeDir: string,
  _options: CreateScreamDeviceIdOptions = {},
): string {
  const deviceIdPath = join(homeDir, 'device_id');
  if (existsSync(deviceIdPath)) {
    try {
      const text = readFileSync(deviceIdPath, 'utf-8').trim();
      if (text.length > 0) return text;
    } catch {
      // Fall through to regenerate.
    }
  }

  const id = randomUUID();
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(deviceIdPath, id, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best-effort: requests can still use the in-memory id.
  }
  return id;
}

export function createLmcodeDeviceHeaders(options: {
  readonly homeDir: string;
  readonly version: string;
}): DeviceHeaders {
  return {
    'X-Msh-Platform': LMCODE_PLATFORM,
    'X-Msh-Version': requiredAsciiHeader(options.version, 'LMcode identity version'),
    'X-Msh-Device-Name': asciiHeader(hostname()),
    'X-Msh-Device-Model': asciiHeader(deviceModel()),
    'X-Msh-Os-Version': asciiHeader(release()),
    'X-Msh-Device-Id': createLmcodeDeviceId(options.homeDir),
  };
}

export function createLmcodeUserAgent(options: {
  readonly userAgentProduct: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}): string {
  const product = requiredAsciiHeader(options.userAgentProduct, 'LMcode identity product');
  const version = requiredAsciiHeader(options.version, 'LMcode identity version');
  const suffix =
    options.userAgentSuffix === undefined ? undefined : asciiHeader(options.userAgentSuffix, '');
  return suffix === undefined || suffix.length === 0
    ? `${product}/${version}`
    : `${product}/${version} (${suffix})`;
}

export function createLmcodeDefaultHeaders(options: LmcodeIdentityOptions): Record<string, string> {
  return {
    'User-Agent': createLmcodeUserAgent(options),
    ...createLmcodeDeviceHeaders({
      homeDir: options.homeDir,
      version: options.version,
    }),
  };
}

export function assertLmcodeHostIdentity(identity: LmcodeHostIdentity | undefined): LmcodeHostIdentity {
  if (identity === undefined) {
    throw new Error('Scream host identity is required. Pass the host product name and version.');
  }
  requiredAsciiHeader(identity.userAgentProduct, 'LMcode identity product');
  requiredAsciiHeader(identity.version, 'LMcode identity version');
  return identity;
}

function deviceModel(): string {
  const os = type();
  const version = release();
  const osArch = arch();
  if (os === 'Darwin') return `macOS ${macOsProductVersion() ?? version} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${version} ${osArch}`;
  return `${os} ${version} ${osArch}`.trim();
}

function macOsProductVersion(): string | undefined {
  try {
    const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function asciiHeader(value: string, fallback = 'unknown'): string {
  const cleaned = value.replaceAll(/[^ -~]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function requiredAsciiHeader(value: string, fieldName: string): string {
  const cleaned = asciiHeader(value, '');
  if (cleaned.length === 0) {
    throw new Error(`${fieldName} must be a non-empty ASCII string.`);
  }
  return cleaned;
}
