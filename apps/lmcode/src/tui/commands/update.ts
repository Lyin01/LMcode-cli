/**
 * /update slash command — manually install the latest LMcode update.
 *
 * Runs `git pull + pnpm install + pnpm -r build` in the detected source clone,
 * then asks the user to restart.  Each step has a timeout and network-
 * error detection with user-friendly Chinese prompts.
 */

import { readUpdateCache } from '#/cli/update/cache';
import { refreshUpdateCache } from '#/cli/update/refresh';
import { selectUpdateTarget } from '#/cli/update/select';
import { resolveSourceInstallDir } from '#/cli/update/source';
import {
  manualUpdateCommand,
  resolveSourceUpdateCommands,
  runSourceProcess,
  type SourceUpdateCommand,
} from '#/cli/update/source-update';
import { UPDATE_ERROR_PREVIEW_LENGTH } from '#/tui/constant/rendering';
import { replaceTabs } from '#/tui/utils/render-text';

import type { SlashCommandHost } from './dispatch';

const UPDATE_STEP_LABELS: Record<SourceUpdateCommand['id'], string> = {
  pull: '拉取最新代码',
  install: '安装依赖',
  build: '编译',
};

const NETWORK_ERROR_PATTERNS = [
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /EPIPE/i,
  /timeout/i,
  /couldn't connect/i,
  /Could not resolve host/i,
  /Failed to connect/i,
  /request failed/i,
  /443/i,
  /TLS/i,
  /SSL/i,
];

function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_PATTERNS.some((p) => p.test(message));
}

interface StepResult {
  ok: boolean;
  message: string;
}

function sanitizeUpdateError(message: string): string {
  const normalized = replaceTabs(message).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= UPDATE_ERROR_PREVIEW_LENGTH
    ? normalized
    : `${normalized.slice(0, UPDATE_ERROR_PREVIEW_LENGTH)}…`;
}

async function runInstallStep(
  cmd: string,
  args: string[],
  cwd: string,
  label: string,
  timeoutMs: number,
): Promise<StepResult> {
  const result = await runSourceProcess({ cmd, args, timeoutMs }, cwd);
  if (result.outcome === 'success') return { ok: true, message: '' };
  if (result.outcome === 'timed-out') {
    const terminationError = result.errorMessage === undefined
      ? ''
      : ` 进程清理失败：${sanitizeUpdateError(result.errorMessage)}`;
    return {
      ok: false,
      message:
        `${label}超时，可能因网络原因卡住。${terminationError}\n` +
        '请检查网络后重试（国内用户建议科学上网）。',
    };
  }

  const msg = sanitizeUpdateError(result.errorMessage ?? result.stderr);
  if (isNetworkError(msg)) {
    return {
      ok: false,
      message:
        `${label}失败：网络连接异常，请检查网络后重试。\n` +
        '（国内用户建议科学上网，如遇网络错误请多尝试几次）',
    };
  }

  const detail = result.signal !== null
    ? `信号 ${result.signal}`
    : `退出码 ${String(result.exitCode)}`;
  return {
    ok: false,
    message: `${label}以 ${detail} 退出${msg.length > 0 ? `：${msg}` : ''}`,
  };
}

export async function handleUpdateCommand(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('请在空闲时执行更新。');
    return;
  }

  host.showStatus('正在检测更新...');

  // Refresh the cache first so we're checking against the latest release.
  await refreshUpdateCache().catch(() => {});
  const cache = await readUpdateCache().catch(() => null);
  const target = selectUpdateTarget(host.state.appState.version, cache?.latest ?? null);
  if (target === null) {
    host.showStatus(
      '✅ 当前已是最新版本（' + host.state.appState.version + '）',
      host.state.theme.colors.success,
    );
    return;
  }

  host.showStatus(`正在更新到 ${target.version}...`);

  const installDir = resolveSourceInstallDir();
  if (installDir === null) {
    host.showError(
      `当前安装不是可自动更新的源码克隆，请手动执行：${manualUpdateCommand()}`,
    );
    return;
  }

  host.showStatus('正在检查 pnpm 运行环境...');
  let commands: readonly SourceUpdateCommand[];
  try {
    commands = await resolveSourceUpdateCommands(installDir);
  } catch (error) {
    const message = sanitizeUpdateError(error instanceof Error ? error.message : String(error));
    host.showError(`无法准备更新环境：${message}`);
    return;
  }

  for (const step of commands) {
    const label = UPDATE_STEP_LABELS[step.id];
    host.showStatus(`正在${label}...`);
    const result = await runInstallStep(
      step.cmd,
      [...step.args],
      installDir,
      label,
      step.timeoutMs,
    );
    if (!result.ok) {
      host.showError(`❌ ${result.message}`);
      return;
    }
  }

  host.showStatus(
    '✅ 更新完成。请重启 LMcode 以使用新版本。',
    host.state.theme.colors.success,
  );
  host.setAppState({ hasNewVersion: false, latestVersion: null });
}
