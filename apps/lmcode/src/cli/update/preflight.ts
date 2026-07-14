import { readUpdateCache } from './cache';
import { promptForInstallConfirmation, type InstallPromptOptions } from './prompt';
import { refreshUpdateCache } from './refresh';
import { selectUpdateTarget } from './select';
import { detectInstallSource, resolveSourceInstallDir } from './source';
import {
  manualUpdateCommand,
  resolveSourceUpdateCommands,
  runSourceProcess,
  sourceUpdateCommands,
  type SourceProcessRunner,
  type SourceUpdateCommand,
} from './source-update';
import {
  type InstallSource,
  type UpdateDecision,
  type UpdatePreflightResult,
  type UpdateTarget,
} from './types';

export type { UpdatePreflightResult } from './types';
export { manualUpdateCommand } from './source-update';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function installSourceUpdate(
  installDir: string,
  commands: readonly SourceUpdateCommand[],
  runProcess: SourceProcessRunner = runSourceProcess,
): Promise<void> {
  for (const command of commands) {
    const result = await runProcess(command, installDir, { stdio: 'inherit' });
    if (result.outcome === 'success') continue;
    if (result.outcome === 'timed-out') {
      throw new Error(`${command.cmd} 超时（${String(command.timeoutMs)}ms）`);
    }
    const detail = result.errorMessage ?? result.stderr.trim();
    const exit = result.exitCode ?? result.signal ?? 'unknown';
    throw new Error(
      `${command.cmd} 失败（exit ${String(exit)}）${detail.length > 0 ? `：${detail}` : ''}`,
    );
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
    const previewCommands = sourceUpdateCommands({ cmd: 'pnpm', argsPrefix: [] });
    const installCommand =
      `cd ${JSON.stringify(installDir)} && ` +
      previewCommands.map(({ cmd, args }) => [cmd, ...args].join(' ')).join(' && ');

    const confirmed = await promptInstall(currentVersion, target, source, installCommand);
    if (!confirmed) return 'continue';

    try {
      const commands = await resolveSourceUpdateCommands(installDir);
      await installSourceUpdate(installDir, commands);
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
