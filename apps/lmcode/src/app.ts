/**
 * LMcode entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, runs the
 * outer update preflight, then delegates to the requested UI runner.
 */

import './utils/suppress-sqlite-warning.js';

import { createProgram } from './cli/commands';

import type { CLIOptions, ValidatedOptions } from './cli/options';
import { OptionConflictError, validateOptions } from './cli/options';
import { getVersion } from './cli/version';
import { initProcessName } from './utils/process/proctitle';

// The runners and the SDK are deliberately loaded at their call sites:
// every static import here is module-evaluated before Commander even
// parses argv, so trivial invocations (`lm --version`, `--help`, bad
// flags) would pay the full agent/TUI bundle init (~600ms measured).
// Keep this module's static graph limited to Commander + option glue.

export async function handleMainCommand(opts: CLIOptions, version: string): Promise<void> {
  let validated: ValidatedOptions;
  try {
    validated = validateOptions(opts);
  } catch (error) {
    if (error instanceof OptionConflictError) {
      process.stderr.write(`错误：${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  // Update check moved to TUI startup — no blocking prompt here.
  // The TUI shows a hint in the Welcome panel when a new version is
  // available, and the user can run /update manually.

  if (validated.uiMode === 'print') {
    const { runPrompt } = await import('./cli/run-prompt');
    await runPrompt(validated.options, version);
    return;
  }

  const { runShell } = await import('./cli/run-shell');
  await runShell(validated.options, version);
}

/** `lmcode migrate` — permanently disabled. */
async function handleMigrateCommand(): Promise<void> {
  process.stdout.write('迁移功能已取消，不再支持从 lmcode-cli 导入数据。\n');
  process.exit(0);
}

export function main(): void {
  initProcessName();

  const version = getVersion();


  const program = createProgram(
    version,
    (opts) => {
      void handleMainCommand(opts, version).catch(async (error: unknown) => {
        const operation = opts.prompt !== undefined ? '运行提示' : '启动交互终端';
        await reportStartupFailure(operation, error);
        process.exit(1);
      });
    },
    () => {
      void handleMigrateCommand().catch(async (error: unknown) => {
        await reportStartupFailure('运行迁移', error);
        process.exit(1);
      });
    },
    (entry, args) => {
      void (async () => {
        const { runPluginNodeEntry } = await import('./cli/sub/plugin-run-node');
        await runPluginNodeEntry(entry, args);
      })().catch(async (error: unknown) => {
        await logStartupFailure('运行插件节点入口', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    (opts) => {
      void (async () => {
        const { runStreamJson } = await import('./cli/run-stream-json');
        await runStreamJson(opts);
      })().catch(async (error: unknown) => {
        await logStartupFailure('运行 stream-json', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    () => {
      void (async () => {
        const { runChannelSetup } = await import('./cli/channel-setup');
        await runChannelSetup();
      })().catch(async (error: unknown) => {
        await logStartupFailure('运行 channel setup', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
  );

  program.parse(process.argv);
}

/** Log, flush, and render a startup failure (heavy imports on demand). */
async function reportStartupFailure(operation: string, error: unknown): Promise<void> {
  await logStartupFailure(operation, error);
  try {
    const { formatStartupError } = await import('./cli/startup-error');
    process.stderr.write(formatStartupError(error, { operation }));
    const { resolveGlobalLogPath, resolveLmcodeHome } = await import('@lmcode-cli/lmcode-sdk');
    process.stderr.write(`查看日志：${resolveGlobalLogPath(resolveLmcodeHome())}\n`);
  } catch {
    // Rendering the pretty error must never mask the original failure.
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
}

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  try {
    const { flushDiagnosticLogs, log } = await import('@lmcode-cli/lmcode-sdk');
    log.error('startup failed', { operation, error });
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
