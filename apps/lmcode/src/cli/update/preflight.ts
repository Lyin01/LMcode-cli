import { spawn } from 'node:child_process';

import { readUpdateCache } from './cache';
import { promptForInstallConfirmation, type InstallPromptOptions } from './prompt';
import { refreshUpdateCache } from './refresh';
import { selectUpdateTarget } from './select';
import { detectInstallSource, resolveSourceInstallDir } from './source';
import {
  type InstallSource,
  type UpdateDecision,
  type UpdatePreflightResult,
  type UpdateTarget,
} from './types';

export type { UpdatePreflightResult } from './types';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one-liner a user can paste to upgrade a source install by hand.
 * install.sh is a no-op pointer on Windows — the clone layout there is
 * produced and upgraded by install.ps1 (same --upgrade flag).
 */
export function manualUpdateCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'cd ~/.lmcode; powershell -ExecutionPolicy Bypass -File install.ps1 --upgrade'
    : 'cd ~/.lmcode && ./install.sh --upgrade';
}

function renderManualUpdateMessage(currentVersion: string, target: UpdateTarget): string {
  return (
    `LMcode 有新版本可用 ` +
    `(${currentVersion} -> ${target.version})。\n` +
    `自动更新失败，请手动执行：\n` +
    `  ${manualUpdateCommand()}\n`
  );
}

function renderInstallSuccessMessage(target: UpdateTarget): string {
  return `已更新至 ${target.version}。请重新启动 lmcode 以使用新版本。\n`;
}

function refreshInBackground(): void {
  void refreshUpdateCache().catch(() => {});
}

async function promptInstall(
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  installCommand: string,
): Promise<boolean> {
  const options: InstallPromptOptions = {
    currentVersion,
    target,
    installCommand,
    installSource: source,
  };
  return promptForInstallConfirmation(options);
}

/**
 * pnpm resolves to a .cmd shim on Windows, which a shell-less spawn cannot
 * execute (ENOENT/EINVAL since Node's CVE-2024-27980 mitigation) — the update
 * then died AFTER `git pull`, leaving the clone half-upgraded. Wrap commands
 * in `cmd.exe /c` so PATHEXT resolution runs; argv boundaries are preserved
 * (no `shell: true`, which Node deprecates with an args array — DEP0190).
 * Mirrors `utils/spawn-command.ts` in agent-core; kept local because the CLI
 * bootstrap deliberately avoids importing the agent-core barrel.
 */
export function spawnTargetForWindows(
  cmd: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform !== 'win32' || /\.exe$/i.test(cmd)) {
    return { cmd, args: [...args] };
  }
  return { cmd: process.env['ComSpec'] ?? 'cmd.exe', args: ['/c', cmd, ...args] };
}

async function installUpdate(installDir: string): Promise<void> {
  const commands: readonly { readonly cmd: string; readonly args: readonly string[]; readonly cwd?: string }[] = [
    { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: installDir },
    { cmd: 'pnpm', args: ['install'], cwd: installDir },
    { cmd: 'pnpm', args: ['-r', 'build'], cwd: installDir },
  ];

  for (const { cmd, args, cwd } of commands) {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const target = spawnTargetForWindows(cmd, args);
    const child = spawn(target.cmd, target.args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} 失败（exit ${code ?? signal}）`));
    });
    await promise;
  }
}

export function decideUpdateAction(
  target: UpdateTarget | null,
  isInteractive: boolean,
): UpdateDecision {
  if (target === null) return 'none';
  if (!isInteractive) return 'manual-command';
  return 'prompt-install';
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const cache = await readUpdateCache().catch(() => null);
    const latest = cache?.latest ?? null;
    const target = selectUpdateTarget(currentVersion, latest);
    refreshInBackground();

    const isInteractive =
      options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
    const source: InstallSource =
      target === null || !isInteractive ? 'unsupported' : detectInstallSource();

    const decision = decideUpdateAction(target, isInteractive);
    if (decision === 'none' || target === null) return 'continue';

    if (source === 'unsupported') {
      stdout.write(renderManualUpdateMessage(currentVersion, target));
      return 'continue';
    }

    // Run the update where the source install was actually detected — with
    // LMCODE_HOME set, that is not necessarily ~/.lmcode.
    const installDir = resolveSourceInstallDir();
    if (installDir === null) {
      stdout.write(renderManualUpdateMessage(currentVersion, target));
      return 'continue';
    }
    const installCommand = `cd ${installDir} && git pull && pnpm install && pnpm -r build`;

    const confirmed = await promptInstall(currentVersion, target, source, installCommand);
    if (!confirmed) return 'continue';

    try {
      await installUpdate(installDir);
      stdout.write(renderInstallSuccessMessage(target));
      return 'exit';
    } catch (error) {
      stderr.write(
        `警告：更新失败：${formatErrorMessage(error)}\n`,
      );
      return 'continue';
    }
  } catch {
    return 'continue';
  }
}
