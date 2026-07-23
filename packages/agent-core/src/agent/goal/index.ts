import { randomUUID } from 'node:crypto';

import { ErrorCodes, LmcodeError } from '#/errors';
import { abortError } from '../../utils/abort';
import type { Agent } from '..';
import type { ContextMessage } from '../context';
import type { AgentRecordOf } from '../records/types';
import { normalizeNonNegativeSafeInteger, normalizeTokenCount } from '../usage';

/**
 * Durable goal-mode state owned by {@link GoalMode}.
 *
 * Each agent keeps exactly one current goal, rebuilt from that agent's ordered
 * record log.
 */

/** Maximum objective length in characters. */
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
/** Maximum completion-criterion length in characters. */
const MAX_GOAL_COMPLETION_CRITERION_LENGTH = 4000;
/** Maximum terminal-reason length in characters. */
const MAX_GOAL_TERMINAL_REASON_LENGTH = 1000;

/** Maximum number of working notes kept per goal. */
const MAX_GOAL_NOTES = 10;
/** Maximum characters per note. */
const MAX_NOTE_LENGTH = 200;

export interface GoalNote {
  readonly content: string;
  readonly time: number;
}

const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
  notes: GoalNote[];
  evidenceStartIndex: number;
}

export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  readonly notes: readonly GoalNote[];
}

export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}

interface GoalReasonInput {
  readonly reason?: string;
}

export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';
export const GOAL_BUDGET_REACHED_REASON = 'A configured budget was reached';

export function isGoalResourceBudgetReached(goal: GoalSnapshot): boolean {
  return goal.budget.tokenBudgetReached || goal.budget.wallClockBudgetReached;
}

export class GoalMode {
  private state: GoalState | undefined;
  private transitionController = new AbortController();

  constructor(private readonly agent: Agent) {}

  normalizeAfterReplay(): void {
    const state = this.state;
    if (state === undefined) return;

    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }

    if (state.status === 'active') {
      const reason = 'Paused after agent resume';
      const next = cloneGoalState(state);
      next.wallClockResumedAt = undefined;
      this.applyStatus(next, 'paused');
      next.terminalReason = reason;
      this.recordAndCommitState(
        next,
        () => this.appendStatusUpdate(next, 'runtime', reason),
        { silent: true, executionBoundaryChanged: true },
      );
      return;
    }
  }

  restoreCreate(record: AgentRecordOf<'goal.create'>): void {
    const objective = normalizeRestoredGoalObjective(record.objective);
    if (objective === undefined) {
      this.state = undefined;
      return;
    }
    const state: GoalState = {
      goalId: record.goalId,
      objective,
      completionCriterion: normalizeCompletionCriterion(record.completionCriterion)?.slice(
        0,
        MAX_GOAL_COMPLETION_CRITERION_LENGTH,
      ),
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
      notes: [],
      evidenceStartIndex: this.agent.context.history.length,
    };
    this.state = state;
  }

  restoreUpdate(record: AgentRecordOf<'goal.update'>): void {
    const current = this.state;
    if (current === undefined) return;
    const state = cloneGoalState(current);

    const status = normalizeGoalStatus(record.status);
    if (status !== undefined) {
      state.status = status;
      state.wallClockResumedAt = undefined;
      state.terminalReason = status === 'active' ? undefined : normalizeGoalReason(record.reason);
    }
    if (record.turnsUsed !== undefined) {
      state.turnsUsed = Math.max(
        state.turnsUsed,
        normalizeNonNegativeSafeInteger(record.turnsUsed),
      );
    }
    if (record.tokensUsed !== undefined) {
      state.tokensUsed = Math.max(state.tokensUsed, normalizeTokenCount(record.tokensUsed));
    }
    if (record.wallClockMs !== undefined) {
      state.wallClockMs = Math.max(
        state.wallClockMs,
        normalizeNonNegativeSafeInteger(record.wallClockMs),
      );
      state.wallClockResumedAt = undefined;
    }
    if (record.budgetLimits !== undefined) {
      state.budgetLimits = {
        ...state.budgetLimits,
        ...normalizeRestoredBudgetLimits(record.budgetLimits),
      };
    }
    if (record.notes !== undefined && Array.isArray(record.notes)) {
      state.notes = record.notes
        .slice(-MAX_GOAL_NOTES)
        .map((note) => ({
          content: String(note.content ?? '').trim().slice(0, MAX_NOTE_LENGTH),
          time:
            typeof note.time === 'number' && Number.isFinite(note.time) ? note.time : Date.now(),
        }))
        .filter((note) => note.content.length > 0);
    }
    this.state = state;
  }

  restoreClear(_record: AgentRecordOf<'goal.clear'>): void {
    this.state = undefined;
  }

  // --- Reads ---

  getGoal(): GoalToolResult {
    const state = this.state;
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  get transitionSignal(): AbortSignal {
    return this.transitionController.signal;
  }

  getEvidenceContext(goalId: string): readonly ContextMessage[] {
    const state = this.state;
    if (state === undefined || state.goalId !== goalId) return [];
    return this.agent.context.history.slice(state.evidenceStartIndex);
  }

  onContextClear(): void {
    const state = this.state;
    if (state !== undefined) state.evidenceStartIndex = 0;
  }

  onContextCompacted(compactedCount: number): void {
    const state = this.state;
    if (state === undefined || state.evidenceStartIndex === 0) return;
    const removedCount = normalizeNonNegativeSafeInteger(compactedCount);
    state.evidenceStartIndex = Math.min(
      this.agent.context.history.length,
      Math.max(1, state.evidenceStartIndex - removedCount + 1),
    );
  }

  onContextMessageRemoved(index: number): void {
    const state = this.state;
    if (state !== undefined && index < state.evidenceStartIndex) {
      state.evidenceStartIndex--;
    }
  }

  // --- Creation ---

  async createGoal(input: CreateGoalInput, _actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new LmcodeError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new LmcodeError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }

    const completionCriterion = normalizeCompletionCriterion(input.completionCriterion);
    if (
      completionCriterion !== undefined &&
      completionCriterion.length > MAX_GOAL_COMPLETION_CRITERION_LENGTH
    ) {
      throw new LmcodeError(
        ErrorCodes.GOAL_COMPLETION_CRITERION_TOO_LONG,
        `Goal completion criterion cannot exceed ${MAX_GOAL_COMPLETION_CRITERION_LENGTH} characters`,
      );
    }

    const existing = this.state;
    if (existing !== undefined) {
      if (input.replace !== true) {
        throw new LmcodeError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
    }

    const state: GoalState = {
      goalId: randomUUID(),
      objective,
      completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: {},
      notes: [],
      evidenceStartIndex: this.agent.context.history.length,
    };

    this.recordAndCommitState(
      state,
      () => {
        this.agent.records.logRecord({
          type: 'goal.create',
          goalId: state.goalId,
          objective: state.objective,
          completionCriterion: state.completionCriterion,
        });
      },
      { executionBoundaryChanged: true },
    );
    return this.toSnapshot(state);
  }

  // --- User-owned lifecycle ---

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new LmcodeError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    const next = cloneGoalState(state);
    const reason = normalizeGoalReason(input.reason);
    this.applyStatus(next, 'paused');
    next.terminalReason = reason;
    this.recordAndCommitState(
      next,
      () => this.appendStatusUpdate(next, actor, reason),
      {
        change: { kind: 'lifecycle', status: 'paused', reason, actor },
        executionBoundaryChanged: true,
      },
    );
    return this.toSnapshot(next);
  }

  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const next = cloneGoalState(state);
    const reason = normalizeGoalReason(input.reason);
    this.applyStatus(next, 'paused');
    next.terminalReason = reason;
    this.recordAndCommitState(
      next,
      () => this.appendStatusUpdate(next, actor, reason),
      {
        change: { kind: 'lifecycle', status: 'paused', reason, actor },
        executionBoundaryChanged: true,
      },
    );
    return this.toSnapshot(next);
  }

  async resumeGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new LmcodeError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    const next = cloneGoalState(state);
    const reason = normalizeGoalReason(input.reason);
    next.terminalReason = undefined;
    this.applyStatus(next, 'active');
    this.recordAndCommitState(
      next,
      () => this.appendStatusUpdate(next, actor, reason),
      {
        change: { kind: 'lifecycle', status: 'active', reason, actor },
        executionBoundaryChanged: true,
      },
    );
    return this.toSnapshot(next);
  }

  async setBudgetLimits(
    input: { budgetLimits: GoalBudgetLimits },
    _actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    validateBudgetLimits(input.budgetLimits);
    const next = cloneGoalState(state);
    next.budgetLimits = { ...next.budgetLimits, ...input.budgetLimits };
    this.recordAndCommitState(next, () => {
      this.appendGoalUpdate({
        budgetLimits: next.budgetLimits,
        wallClockMs: liveWallClockMs(next),
      });
    });
    return this.toSnapshot(next);
  }

  async cancelGoal(actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.recordAndCommitState(
      undefined,
      () => this.agent.records.logRecord({ type: 'goal.clear' }),
      { executionBoundaryChanged: true },
    );
    if (actor === 'user') {
      this.agent.context.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      });
    }
    return snapshot;
  }

  // --- Terminal outcomes ---

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const next = cloneGoalState(state);
    const reason = normalizeGoalReason(input.reason);
    this.applyStatus(next, 'blocked');
    next.terminalReason = reason;
    this.recordAndCommitState(
      next,
      () => this.appendStatusUpdate(next, actor, reason),
      {
        change: { kind: 'lifecycle', status: 'blocked', reason, actor },
        executionBoundaryChanged: true,
      },
    );
    return this.toSnapshot(next);
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const next = cloneGoalState(state);
    const reason = normalizeGoalReason(input.reason);
    this.applyStatus(next, 'complete');
    next.terminalReason = reason;
    const snapshot = this.toSnapshot(next);
    this.recordAndCommitState(
      next,
      () => this.appendStatusUpdate(next, actor, reason),
      { silent: true, executionBoundaryChanged: true },
    );
    if (this.state !== next) return snapshot;
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason,
      stats: this.statsOf(next),
      actor,
    });
    if (this.state === next) this.clearInternal(actor);
    return snapshot;
  }

  // --- User-interrupt transition ---

  async pauseOnInterrupt(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  // --- Accounting & reporting ---

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.recordTokenUsageForGoal(state.goalId, tokenDelta);
  }

  async recordTokenUsageForGoal(
    goalId: string,
    tokenDelta: number,
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.goalId !== goalId) return null;
    const next = cloneGoalState(state);
    const delta = normalizeTokenCount(tokenDelta);
    next.tokensUsed = normalizeTokenCount(
      normalizeTokenCount(next.tokensUsed) + delta,
    );
    this.recordAndCommitState(
      next,
      () => {
        this.appendGoalUpdate({
          tokensUsed: next.tokensUsed,
          wallClockMs: liveWallClockMs(next),
        });
      },
      { silent: true },
    );
    return this.toSnapshot(next);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const next = cloneGoalState(state);
    next.turnsUsed = normalizeNonNegativeSafeInteger(next.turnsUsed + 1);
    this.recordAndCommitState(next, () => {
      this.appendGoalUpdate({
        turnsUsed: next.turnsUsed,
        wallClockMs: liveWallClockMs(next),
      });
    });
    return this.toSnapshot(next);
  }

  async addNote(content: string): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const trimmed = content.trim().slice(0, MAX_NOTE_LENGTH);
    if (trimmed.length === 0) return this.toSnapshot(state);
    const next = cloneGoalState(state);
    next.notes.push({ content: trimmed, time: Date.now() });
    if (next.notes.length > MAX_GOAL_NOTES) {
      next.notes = next.notes.slice(-MAX_GOAL_NOTES);
    }
    this.recordAndCommitState(next, () => {
      this.appendGoalUpdate({
        notes: next.notes,
        wallClockMs: liveWallClockMs(next),
      });
    });
    return this.toSnapshot(next);
  }

  // --- Internals ---

  private clearInternal(
    _actor: GoalActor,
    opts: { emit?: boolean; track?: boolean } = {},
  ): void {
    const state = this.state;
    if (state === undefined) return;
    this.recordAndCommitState(
      undefined,
      () => {
        if (opts.track !== false) {
          this.agent.records.logRecord({ type: 'goal.clear' });
        }
      },
      { silent: opts.emit === false },
    );
  }

  private notifyExecutionBoundaryChanged(): void {
    const previous = this.transitionController;
    this.transitionController = new AbortController();
    previous.abort(abortError());
    this.agent.permission.cancelAllApprovals();
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, reason?: string): void {
    this.appendGoalUpdate({
      status: state.status,
      reason,
      wallClockMs: liveWallClockMs(state, Date.now()),
      actor,
    });
  }

  private appendGoalUpdate(
    update: Omit<AgentRecordOf<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.agent.records.logRecord({
      type: 'goal.update',
      ...update,
    });
  }

  private applyStatus(state: GoalState, status: GoalStatus): void {
    const now = Date.now();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs = normalizeNonNegativeSafeInteger(
        state.wallClockMs + normalizeNonNegativeSafeInteger(now - state.wallClockResumedAt),
      );
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new LmcodeError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }

  private recordAndCommitState(
    state: GoalState | undefined,
    record: () => void,
    opts: {
      silent?: boolean;
      change?: GoalChange;
      executionBoundaryChanged?: boolean;
    } = {},
  ): void {
    const previousState = this.state;
    const previousTransitionController = this.transitionController;
    this.state = state;

    try {
      record();
    } catch (error) {
      if (this.state === state) this.state = previousState;
      throw error;
    }

    if (
      opts.executionBoundaryChanged === true &&
      this.transitionController === previousTransitionController
    ) {
      this.notifyExecutionBoundaryChanged();
    }
    if (this.state !== state) return;
    if (opts.silent !== true) {
      this.emitGoalUpdated(state === undefined ? null : this.toSnapshot(state), opts.change);
    }
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.agent.emitEvent({ type: 'goal.updated', snapshot, change });
  }

  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    const now = Date.now();
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, now),
      budget: computeBudgetReport(state, now),
      terminalReason: state.terminalReason,
      notes: state.notes.map((note) => ({ ...note })),
    };
  }
}

function cloneGoalState(state: GoalState): GoalState {
  return {
    ...state,
    budgetLimits: { ...state.budgetLimits },
    notes: [...state.notes],
  };
}

function liveWallClockMs(state: GoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return normalizeNonNegativeSafeInteger(
      state.wallClockMs + normalizeNonNegativeSafeInteger(now - state.wallClockResumedAt),
    );
  }
  return normalizeNonNegativeSafeInteger(state.wallClockMs);
}

function computeBudgetReport(state: GoalState, now: number = Date.now()): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function normalizeRestoredGoalObjective(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_GOAL_OBJECTIVE_LENGTH) : undefined;
}

function normalizeCompletionCriterion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed?.length ? trimmed : undefined;
}

function normalizeGoalReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed?.length ? trimmed.slice(0, MAX_GOAL_TERMINAL_REASON_LENGTH) : undefined;
}

function normalizeGoalStatus(value: unknown): GoalStatus | undefined {
  if (value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete') {
    return value;
  }
  return undefined;
}

function normalizeRestoredBudgetLimits(value: unknown): GoalBudgetLimits {
  if (typeof value !== 'object' || value === null) return {};
  const input = value as Record<string, unknown>;
  const normalized: {
    tokenBudget?: number;
    turnBudget?: number;
    wallClockBudgetMs?: number;
  } = {};
  const tokenBudget = normalizeBudgetLimit(input['tokenBudget']);
  const turnBudget = normalizeBudgetLimit(input['turnBudget']);
  const wallClockBudgetMs = normalizeBudgetLimit(input['wallClockBudgetMs']);
  if (tokenBudget !== undefined) normalized.tokenBudget = tokenBudget;
  if (turnBudget !== undefined) normalized.turnBudget = turnBudget;
  if (wallClockBudgetMs !== undefined) normalized.wallClockBudgetMs = wallClockBudgetMs;
  return normalized;
}

function normalizeBudgetLimit(value: unknown): number | undefined {
  return isPositiveSafeInteger(value) ? value : undefined;
}

function validateBudgetLimits(limits: GoalBudgetLimits): void {
  validateBudgetLimit('tokenBudget', limits.tokenBudget);
  validateBudgetLimit('turnBudget', limits.turnBudget);
  validateBudgetLimit('wallClockBudgetMs', limits.wallClockBudgetMs);
}

function validateBudgetLimit(
  field: keyof GoalBudgetLimits,
  value: number | undefined,
): void {
  if (value === undefined) return;
  if (isPositiveSafeInteger(value)) return;
  throw new LmcodeError(
    ErrorCodes.GOAL_BUDGET_INVALID,
    `${field} must be a positive safe integer`,
    { details: { field, value: String(value) } },
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
