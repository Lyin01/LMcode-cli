/**
 * `lm export` sub-command.
 *
 * CLI glue only: session lookup, previous-session confirmation, and output.
 * The actual ZIP/manifest export is owned by the SDK.
 */

import { createInterface } from 'node:readline/promises';

// The SDK harness is imported lazily inside `getHarness`: this module is
// evaluated while Commander builds the program for EVERY invocation, so a
// static SDK import here would put the whole agent stack on the
// `lm --version` startup path (type-only imports are free). It stays lazy
// even inside `createDefaultExportDeps` so callers that inject their own
// session deps (tests) never load the SDK at all. The remaining imports
// below are small leaf modules — `#/cli/version` is on the startup graph
// anyway — and safe to keep static.
import type {
  ExportSessionInput,
  ExportSessionResult,
  LmcodeHarness as LmcodeHarnessType,
  SessionSummary,
  ShellEnvironment,
} from '@lmcode-cli/lmcode-sdk';
import type { Command } from 'commander';

import { createLmcodeHostIdentity } from '#/cli/version';
import { detectShellEnvironment } from '#/utils/process/shell-env';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface PreviousSessionSummary {
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly title?: string | undefined;
}

export interface ExportDeps {
  readonly listSessions: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly exportSession: (input: ExportSessionInput) => Promise<ExportSessionResult>;
  readonly confirmPreviousSession: (summary: PreviousSessionSummary) => Promise<boolean>;
  readonly getInstallSource: () => Promise<string>;
  readonly getShellEnv: () => ShellEnvironment;
  readonly version: string;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ExportOptions {
  readonly yes: boolean;
  readonly includeGlobalLog: boolean;
}

export async function handleExport(
  deps: ExportDeps,
  sessionId: string | undefined,
  output: string | undefined,
  opts: ExportOptions,
): Promise<void> {
  const requestedId = normalizeOptionalSessionId(sessionId);
  const previousSummary = requestedId === undefined ? await findPreviousSession(deps) : undefined;

  let resolvedId: string;
  if (requestedId !== undefined) {
    resolvedId = requestedId;
  } else {
    if (previousSummary === undefined) {
      deps.stderr.write('未找到可导出的历史会话。\n');
      deps.exit(1);
    }
    resolvedId = previousSummary.id;
    if (!opts.yes) {
      const confirmed = await deps.confirmPreviousSession(toPreviousSessionSummary(previousSummary));
      if (!confirmed) {
        deps.stdout.write('导出已取消。\n');
        return;
      }
    }
  }

  try {
    const installSource = await deps.getInstallSource();
    const shellEnv = deps.getShellEnv();
    const result = await deps.exportSession({
      id: resolvedId,
      version: deps.version,
      installSource,
      shellEnv,
      ...(output === undefined ? {} : { outputPath: output }),
      ...(opts.includeGlobalLog ? { includeGlobalLog: true } : {}),
    });
    deps.stdout.write(`${result.zipPath}\n`);
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerExportCommand(parent: Command, deps?: Partial<ExportDeps>): void {
  parent
    .command('export')
    .description('导出会话为 ZIP 压缩包。')
    .option('-o, --output <path>', '输出 ZIP 路径。')
    .option('-y, --yes', '跳过历史会话确认。')
    .option(
      '--no-include-global-log',
      '不打包当前全局诊断日志（~/.lmcode/logs/lmcode.log，不含轮转的 .1 文件）。默认会包含全局日志。',
    )
    .argument('[sessionId]', '要导出的会话 ID。默认使用最近的会话。')
    .action(
      async (
        sessionId: string | undefined,
        options: { output?: string; yes?: boolean; includeGlobalLog?: boolean },
      ) => {
        await handleExport(createDefaultExportDeps(deps), sessionId, options.output, {
          yes: options.yes === true,
          includeGlobalLog: options.includeGlobalLog !== false,
        });
      },
    );
}

function createDefaultExportDeps(overrides: Partial<ExportDeps> = {}): ExportDeps {
  const identity = createLmcodeHostIdentity();
  let harnessPromise: Promise<LmcodeHarnessType> | undefined;
  const getHarness = (): Promise<LmcodeHarnessType> => {
    harnessPromise ??= (async () => {
      const { LmcodeHarness, resolveLmcodeHome } = await import('@lmcode-cli/lmcode-sdk');
      return new LmcodeHarness({
        homeDir: resolveLmcodeHome(),
        identity,
      });
    })();
    return harnessPromise;
  };
  return {
    listSessions:
      overrides.listSessions ??
      (async (workDir: string) =>
        (await getHarness()).listSessions({
          workDir,
        })),
    exportSession:
      overrides.exportSession ??
      (async (input: ExportSessionInput) => (await getHarness()).exportSession(input)),
    version: overrides.version ?? identity.version,
    // Lazy: `#/cli/update/source` imports `resolveLmcodeHome` from the SDK,
    // which would drag the agent stack back onto the startup path.
    getInstallSource:
      overrides.getInstallSource ??
      (async () => (await import('#/cli/update/source')).detectInstallSource()),
    getShellEnv: overrides.getShellEnv ?? detectShellEnvironment,
    confirmPreviousSession: overrides.confirmPreviousSession ?? confirmPreviousSession,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

async function findPreviousSession(deps: Pick<ExportDeps, 'cwd' | 'listSessions'>): Promise<
  SessionSummary | undefined
> {
  const sessions = await deps.listSessions(deps.cwd());
  return sessions[0];
}

function toPreviousSessionSummary(summary: SessionSummary): PreviousSessionSummary {
  return {
    workDir: summary.workDir,
    sessionId: summary.id,
    sessionDir: summary.sessionDir,
    ...(summary.title === undefined ? {} : { title: summary.title }),
  };
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

async function confirmPreviousSession(summary: PreviousSessionSummary): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const title = summary.title === undefined ? summary.sessionId : `${summary.title} (${summary.sessionId})`;
    const answer = await rl.question(`导出历史会话 "${title}"？[Y/n] `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
