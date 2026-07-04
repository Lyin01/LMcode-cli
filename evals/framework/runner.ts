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
 *   5. `session.prompt(task.prompt)`, wait for `turn.ended`.
 *   6. Pull usage, then `task.score(workdir)`.
 *
 * Everything is wrapped so a thrown error becomes a failed `RunResult` rather
 * than crashing the whole suite.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { LmcodeHarness } from '@lmcode-cli/lmcode-sdk';
import type { Event, LmcodeConfigPatch, SessionUsage } from '@lmcode-cli/lmcode-sdk';

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
  /** Hard ceiling on a single turn before we give up (ms). */
  readonly turnTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

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

function waitForTurnEnd(
  session: { onEvent(listener: (event: Event) => void): () => void },
  timeoutMs: number,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for turn.ended`));
    }, timeoutMs);
    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'error') {
        clearTimeout(timer);
        unsubscribe();
        const message = 'message' in event ? String(event.message) : 'session error';
        reject(new Error(`Session error event: ${message}`));
        return;
      }
      if (event.type !== 'turn.ended') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
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
    await harness.setConfig(provider.config);

    const session = await harness.createSession({
      workDir,
      model: provider.model,
      // Auto-approve tool calls so the agent can write/run without a human.
      permission: 'yolo',
    });

    const turnEnded = waitForTurnEnd(session, timeoutMs);
    await session.prompt(task.prompt);
    const endEvent = await turnEnded;

    if (endEvent.type === 'turn.ended' && endEvent.reason === 'error') {
      const reason =
        endEvent.error && 'message' in endEvent.error
          ? String((endEvent.error as { message?: unknown }).message)
          : 'turn ended with error';
      throw new Error(reason);
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
