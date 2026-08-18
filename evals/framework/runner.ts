/**
 * The eval runner: drives one `Task` against a real `@lmcode-cli/lmcode-sdk`
 * session and scores the resulting workdir.
 *
 * Flow per task:
 *   1. Make a fresh temp home dir (isolated config) + workdir.
 *   2. `task.setup(workdir)` lays down the fixture.
 *   3. Configure the chosen provider/model on the harness.
 *   4. Create a session in `yolo` permission mode (auto-approve tool calls so
 *      the agent can write files without an interactive approver).
 *   5. `session.prompt(task.prompt)`, wait until the session is idle
 *      (in-flight turns drop to zero). Goal mode can emit an extra `turn.ended`
 *      for the standalone turn and then immediately start `driveGoal` — scoring
 *      on the first `turn.ended` would freeze a half-finished workdir.
 *   6. If the last turn `failed` or was `cancelled`, treat that as a harness
 *      error (do not score). Otherwise pull usage and `task.score(workdir)`.
 *
 * Everything is wrapped so a thrown error becomes a failed `RunResult` rather
 * than crashing the whole suite.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { LmcodeHarness } from '@lmcode-cli/lmcode-sdk';
import type { LmcodeConfigPatch, SessionUsage } from '@lmcode-cli/lmcode-sdk';

import { abnormalTurnMessage, waitForSessionIdle } from './session-idle';
import type { RunResult, RunTokens, Task } from './types';

const TEST_IDENTITY = {
  userAgentProduct: 'lmcode-cli',
  version: '0.0.0-eval',
} as const;

/** Provider/model wiring for a run. */
export interface ProviderSetup {
  /** Config patch applied via `harness.setConfig` (providers + models). */
  readonly config: LmcodeConfigPatch;
  /** Model alias to select for the session. */
  readonly model: string;
}

export interface RunTaskOptions {
  readonly task: Task;
  readonly provider: ProviderSetup;
  /** Hard ceiling on the prompt-to-idle window before we give up (ms). */
  readonly turnTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/** Tools that can change eval scoring time or freeze a half-finished workdir. */
const EVAL_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Grep',
  'Glob',
  'Bash',
  'TodoList',
] as const;

const EVAL_SESSION_PROMPT = [
  'This is a single-turn evaluation in an isolated workdir.',
  'Do not create goals, spawn sub-agents, enter plan mode, or use WolfPack.',
  'Do not edit files the prompt asked you to leave alone (for example test/ or check scripts).',
  'Finish by writing the required files and running the stated checks.',
].join(' ');

function sumUsage(usage: SessionUsage | undefined): RunTokens | undefined {
  const total = usage?.total;
  if (total === undefined) return undefined;
  const input = total.inputOther + total.inputCacheRead + total.inputCacheCreation;
  return { input, output: total.output, total: input + total.output };
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function removeTempDir(dir: string): Promise<void> {
  // Windows can briefly hold file handles after the session closes; retry.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') return;
      await delay(20);
    }
  }
}

/**
 * Run a single task and return its result row. Never throws — failures are
 * captured in the returned `RunResult`.
 */
export async function runTask(options: RunTaskOptions): Promise<RunResult> {
  const { task, provider } = options;
  const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const started = Date.now();

  const base = {
    taskId: task.id,
    description: task.description,
    kind: task.kind,
    skipped: false,
  } as const;

  const homeDir = await makeTempDir('lmcode-eval-home-');
  const workDir = await makeTempDir('lmcode-eval-work-');

  let harness: LmcodeHarness | undefined;
  try {
    await task.setup(workDir);

    harness = new LmcodeHarness({ identity: TEST_IDENTITY, homeDir });
    await harness.setConfig({
      ...provider.config,
      enableSelfHealing: false,
      enableSpecCritic: true,
      anchoredBootstrap: { enabled: false },
      defaultPlanMode: false,
      defaultFileSandbox: 'workspace-write',
      loopControl: {
        maxStepsPerTurn: 80,
        maxRetriesPerStep: 2,
        maxPostWriteReviewsPerTurn: 0,
      },
    });

    const session = await harness.createSession({
      workDir,
      model: provider.model,
      permission: 'yolo',
      planMode: false,
      additionalSystemPrompt: EVAL_SESSION_PROMPT,
    });
    await session.setActiveTools(EVAL_TOOLS);

    const abort = new AbortController();
    const idle = waitForSessionIdle(session, timeoutMs, abort.signal);
    let endEvent;
    try {
      await session.prompt(task.prompt);
      endEvent = await idle;
    } catch (error) {
      abort.abort();
      await idle.catch(() => undefined);
      throw error;
    }

    const abnormal = abnormalTurnMessage(endEvent);
    if (abnormal !== undefined) {
      throw new Error(abnormal);
    }

    let tokens: RunTokens | undefined;
    try {
      tokens = sumUsage(await session.getUsage());
    } catch {
      tokens = undefined;
    }

    const score = await task.score(workDir);
    const durationMs = Date.now() - started;

    return {
      ...base,
      passed: score.passed,
      score: score.score,
      details: score.details,
      durationMs,
      tokens,
    };
  } catch (error) {
    return {
      ...base,
      passed: false,
      score: 0,
      details: 'run failed before scoring',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Skip memory extraction on close — it would fire an extra LLM turn.
    await harness?.close().catch(() => {});
    await removeTempDir(workDir);
    await removeTempDir(homeDir);
  }
}

/** Build a `RunResult` for a task that was skipped (no model configured, etc.). */
export function skippedResult(task: Task, reason: string): RunResult {
  return {
    taskId: task.id,
    description: task.description,
    kind: task.kind,
    skipped: true,
    skipReason: reason,
    passed: false,
    score: 0,
    details: reason,
    durationMs: 0,
  };
}
