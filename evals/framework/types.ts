/**
 * Core types for the LMcode agent eval harness.
 *
 * A `Task` is a self-contained, scorable unit of work: it creates a fixture in
 * a fresh temp workdir, hands the agent a prompt, then inspects the resulting
 * workdir to decide pass/fail. The harness deliberately treats the agent as a
 * black box — it drives a real `@lmcode-cli/lmcode-sdk` session and scores the
 * *side effects on disk*, not the transcript. That keeps scorers honest and
 * model-agnostic.
 */

/** Outcome of scoring a single task run. */
export interface ScoreResult {
  /** Hard pass/fail. The aggregate pass-rate is computed from this. */
  readonly passed: boolean;
  /**
   * Soft score in [0, 1]. For a binary scorer this is just `passed ? 1 : 0`,
   * but partial-credit scorers can return anything in between.
   */
  readonly score: number;
  /** Human-readable explanation shown in the report and on failure. */
  readonly details: string;
}

/**
 * How a task wants to be driven. `fake` runs against a keyless local stub
 * provider (plumbing only); `real` requires a configured model + provider key.
 */
export type TaskKind = 'fake' | 'real';

export interface Task {
  /** Stable identifier, used for filtering on the CLI (e.g. `pnpm eval <id>`). */
  readonly id: string;
  /** One-line description shown in the report header. */
  readonly description: string;
  /**
   * Which driver this task needs. `real` tasks are skipped automatically unless
   * a model is configured via env (see `resolveRealModel`).
   */
  readonly kind: TaskKind;
  /**
   * Populate the fresh, empty `workdir` with fixture files before the agent
   * runs. Runs once per task execution.
   */
  setup(workdir: string): Promise<void>;
  /** The instruction handed to the agent verbatim. */
  readonly prompt: string;
  /**
   * Inspect the post-run `workdir` and decide pass/fail. Must not depend on the
   * agent transcript — only on observable disk state — so the verdict is
   * reproducible and model-independent.
   */
  score(workdir: string): Promise<ScoreResult>;
}

/** Token usage rolled up for a single run (subset of the SDK's TokenUsage). */
export interface RunTokens {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

/** One row in the results table. */
export interface RunResult {
  readonly taskId: string;
  readonly description: string;
  readonly kind: TaskKind;
  /** `true` when the task was skipped (e.g. real task with no model configured). */
  readonly skipped: boolean;
  /** Why it was skipped, when `skipped` is true. */
  readonly skipReason?: string;
  readonly passed: boolean;
  readonly score: number;
  readonly details: string;
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs: number;
  /** Token usage if the session reported any; `undefined` otherwise. */
  readonly tokens?: RunTokens | undefined;
  /** Set when the run threw before scoring (harness/agent error). */
  readonly error?: string | undefined;
}
