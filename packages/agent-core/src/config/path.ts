import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'pathe';

export function resolveLmcodeHome(
  homeDir?: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  if (homeDir !== undefined) return homeDir;
  if (environment['LMCODE_RUNTIME_ENV'] === 'development') {
    const developmentHome =
      environmentPath(environment, 'LMCODE_DEVELOPMENT_HOME') ??
      join(homedir(), '.lmcode-development');
    const productionHome =
      environmentPath(environment, 'LMCODE_HOME') ?? join(homedir(), '.lmcode');
    if (comparablePath(developmentHome) === comparablePath(productionHome)) {
      throw new Error('LMCODE_DEVELOPMENT_HOME must not point at the production LMCODE_HOME');
    }
    return developmentHome;
  }
  return environmentPath(environment, 'LMCODE_HOME') ?? join(homedir(), '.lmcode');
}

function environmentPath(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === '' ? undefined : value;
}

function comparablePath(value: string): string {
  const absolutePath = resolve(value);
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}, environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return input.configPath ?? join(resolveLmcodeHome(input.homeDir, environment), 'config.toml');
}

export function ensureLmcodeHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
