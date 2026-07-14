import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import {
  spawnTargetForWindows,
  terminateProcessTree,
} from '#/utils/process/spawn-command';

export const REQUIRED_PNPM_VERSION = '11.7.0';

export interface SourceCommandInvocation {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface SourceUpdateCommand extends SourceCommandInvocation {
  readonly id: 'pull' | 'install' | 'build';
}

export interface PnpmCommand {
  readonly cmd: 'pnpm' | 'corepack';
  readonly argsPrefix: readonly string[];
}

export interface SourceProcessResult {
  readonly outcome: 'success' | 'failed' | 'timed-out';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage?: string;
}

export interface RunSourceProcessOptions {
  readonly stdio?: 'pipe' | 'inherit';
  readonly spawnCommand?: typeof spawn;
  readonly terminate?: (child: ChildProcess) => Promise<void>;
}

export type SourceProcessRunner = (
  invocation: SourceCommandInvocation,
  cwd: string,
  options?: RunSourceProcessOptions,
) => Promise<SourceProcessResult>;

export interface ResolvePnpmCommandOptions {
  readonly runProcess?: SourceProcessRunner;
}

const VERSION_PROBE_TIMEOUT_MS = 30_000;
const COREPACK_PREPARE_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_OUTPUT_LENGTH = 64 * 1024;

const PULL_COMMAND: SourceUpdateCommand = {
  id: 'pull',
  cmd: 'git',
  args: ['pull', '--ff-only', 'origin', 'main'],
  timeoutMs: 120_000,
};

export function pnpmVersionIsCompatible(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 11 && (minor > 7 || (minor === 7 && patch >= 0));
}

export function sourceUpdateCommands(pnpmCommand: PnpmCommand): readonly SourceUpdateCommand[] {
  return [
    PULL_COMMAND,
    {
      id: 'install',
      cmd: pnpmCommand.cmd,
      args: [...pnpmCommand.argsPrefix, 'install', '--frozen-lockfile'],
      timeoutMs: 180_000,
    },
    {
      id: 'build',
      cmd: pnpmCommand.cmd,
      args: [...pnpmCommand.argsPrefix, '-r', 'build'],
      timeoutMs: 180_000,
    },
  ];
}

export async function resolvePnpmCommand(
  cwd: string,
  options: ResolvePnpmCommandOptions = {},
): Promise<PnpmCommand> {
  const runProcess = options.runProcess ?? runSourceProcess;
  const installed = await runProcess(
    { cmd: 'pnpm', args: ['--version'], timeoutMs: VERSION_PROBE_TIMEOUT_MS },
    cwd,
  );
  if (installed.outcome === 'success' && pnpmVersionIsCompatible(installed.stdout)) {
    return { cmd: 'pnpm', argsPrefix: [] };
  }

  await runProcess(
    {
      cmd: 'corepack',
      args: ['prepare', `pnpm@${REQUIRED_PNPM_VERSION}`, '--activate'],
      timeoutMs: COREPACK_PREPARE_TIMEOUT_MS,
    },
    cwd,
  );
  const corepack = await runProcess(
    {
      cmd: 'corepack',
      args: ['pnpm', '--version'],
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    },
    cwd,
  );
  if (corepack.outcome === 'success' && pnpmVersionIsCompatible(corepack.stdout)) {
    return { cmd: 'corepack', argsPrefix: ['pnpm'] };
  }

  throw new Error(
    `pnpm ${REQUIRED_PNPM_VERSION} could not be activated; rerun the source installer`,
  );
}

export async function resolveSourceUpdateCommands(
  cwd: string,
  options: ResolvePnpmCommandOptions = {},
): Promise<readonly SourceUpdateCommand[]> {
  return sourceUpdateCommands(await resolvePnpmCommand(cwd, options));
}

export async function runSourceProcess(
  invocation: SourceCommandInvocation,
  cwd: string,
  options: RunSourceProcessOptions = {},
): Promise<SourceProcessResult> {
  const stdio = options.stdio ?? 'pipe';
  const target = spawnTargetForWindows(invocation.cmd, invocation.args);
  const spawnOptions: SpawnOptions = {
    cwd,
    stdio,
    detached: process.platform !== 'win32',
  };
  const child = (options.spawnCommand ?? spawn)(target.cmd, target.args, spawnOptions);
  const terminate = options.terminate ?? terminateProcessTree;
  let resolve!: (result: SourceProcessResult) => void;
  const promise = new Promise<SourceProcessResult>((res) => {
    resolve = res;
  });
  let stdout = '';
  let stderr = '';
  let settled = false;

  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = appendCapturedOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = appendCapturedOutput(stderr, chunk);
  });

  const finish = (result: SourceProcessResult): void => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  child.once('error', (error: Error) => {
    finish({
      outcome: 'failed',
      exitCode: child.exitCode,
      signal: child.signalCode,
      stdout,
      stderr,
      errorMessage: error.message,
    });
  });
  child.once('close', (exitCode, signal) => {
    finish({
      outcome: exitCode === 0 ? 'success' : 'failed',
      exitCode,
      signal,
      stdout,
      stderr,
    });
  });

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    void terminate(child).then(
      () => {
        resolve({
          outcome: 'timed-out',
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
        });
      },
      (error: unknown) => {
        resolve({
          outcome: 'timed-out',
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, invocation.timeoutMs);
  timeout.unref();

  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
  }
}

export function manualUpdateCommand(): string {
  return 'npm install -g @liumir/lmcode@latest';
}

function appendCapturedOutput(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length <= MAX_CAPTURED_OUTPUT_LENGTH
    ? combined
    : combined.slice(-MAX_CAPTURED_OUTPUT_LENGTH);
}
