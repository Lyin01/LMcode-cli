import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

export function resolveLmcodeHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['LMCODE_HOME'] ?? join(homedir(), '.lmcode');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveLmcodeHome(input.homeDir), 'config.toml');
}

export function ensureLmcodeHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
