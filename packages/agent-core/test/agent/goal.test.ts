import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GoalBudgetLimits, GoalStatus } from '../../src/agent/goal';
import {
  InMemoryAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
} from '../../src/agent/records';
import { ErrorCodes } from '../../src/errors';
import { testAgent } from './harness/agent';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('goal state contracts', () => {
  it('does not expose mutable working-note state through goal snapshots', async () => {
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Keep snapshots isolated' });
    const snapshot = await ctx.agent.goal.addNote('Original internal note');
    const exposedNotes = snapshot?.notes as Array<{ content: string; time: number }>;

    exposedNotes[0]!.content = 'Tampered note';
    exposedNotes.push({ content: 'Injected note', time: 0 });

    expect(ctx.agent.goal.getGoal().goal?.notes).toEqual([
      expect.objectContaining({ content: 'Original internal note' }),
    ]);
  });

  it('uses one clock reading for elapsed time and the budget report', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Keep snapshot timing consistent' });
    await ctx.agent.goal.setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 100 } });
    let reads = 0;
    now.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? 1_099 : 1_100;
    });

    const snapshot = ctx.agent.goal.getGoal().goal;

    expect(snapshot).toMatchObject({
      wallClockMs: 99,
      budget: {
        remainingWallClockMs: 1,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    });
    expect(reads).toBe(1);
  });

  it('appends replay records before publishing each goal state change', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.agent.goal.createGoal({ objective: 'Publish journaled goal state' });
    await ctx.agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 100 } });
    await ctx.agent.goal.pauseGoal();
    await ctx.agent.goal.resumeGoal();
    await ctx.agent.goal.cancelGoal();

    const sequence = ctx.allEvents.flatMap((event): string[] => {
      if (
        event.type === '[wire]' &&
        (event.event === 'goal.create' ||
          event.event === 'goal.update' ||
          event.event === 'goal.clear')
      ) {
        return [`record:${event.event}`];
      }
      if (event.type !== '[rpc]' || event.event !== 'goal.updated') return [];
      const snapshot = (event.args as { readonly snapshot?: { readonly status?: string } | null })
        .snapshot;
      return [`publish:${snapshot?.status ?? 'null'}`];
    });

    expect(sequence).toEqual([
      'record:goal.create',
      'publish:active',
      'record:goal.update',
      'publish:active',
      'record:goal.update',
      'publish:paused',
      'record:goal.update',
      'publish:active',
      'record:goal.clear',
      'publish:null',
    ]);
  });

  it('does not retain or publish a goal whose create record cannot be appended', async () => {
    const store = controllablePersistence();
    store.failOn('goal.create');
    const ctx = testAgent({ persistence: store.persistence });
    ctx.configure();

    await expect(
      ctx.agent.goal.createGoal({ objective: 'Must be recoverable' }),
    ).rejects.toThrow('record append failed for goal.create');

    expect(ctx.agent.goal.getGoal().goal).toBeNull();
    expect(
      ctx.allEvents.filter(
        (event) => event.type === '[rpc]' && event.event === 'goal.updated',
      ),
    ).toEqual([]);
  });

  it('retains the original goal when a replacement create record cannot be appended', async () => {
    const store = controllablePersistence();
    const ctx = testAgent({ persistence: store.persistence });
    ctx.configure();
    const original = await ctx.agent.goal.createGoal({ objective: 'Original recoverable goal' });
    const publishedBeforeReplace = publishedGoalEventCount(ctx.allEvents);
    store.failOn('goal.create');

    await expect(
      ctx.agent.goal.createGoal({ objective: 'Unrecorded replacement', replace: true }),
    ).rejects.toThrow('record append failed for goal.create');

    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      goalId: original.goalId,
      objective: 'Original recoverable goal',
      status: 'active',
    });
    expect(publishedGoalEventCount(ctx.allEvents)).toBe(publishedBeforeReplace);
  });

  it('keeps the previous goal state when update or clear records cannot be appended', async () => {
    const updateStore = controllablePersistence();
    const updateCtx = testAgent({ persistence: updateStore.persistence });
    updateCtx.configure();
    const original = await updateCtx.agent.goal.createGoal({
      objective: 'Keep the journaled state',
    });
    const publishedBeforeUpdate = publishedGoalEventCount(updateCtx.allEvents);
    updateStore.failOn('goal.update');

    await expect(updateCtx.agent.goal.pauseGoal()).rejects.toThrow(
      'record append failed for goal.update',
    );

    expect(updateCtx.agent.goal.getGoal().goal).toMatchObject({
      goalId: original.goalId,
      status: 'active',
    });
    expect(publishedGoalEventCount(updateCtx.allEvents)).toBe(publishedBeforeUpdate);

    const clearStore = controllablePersistence();
    const clearCtx = testAgent({ persistence: clearStore.persistence });
    clearCtx.configure();
    const retained = await clearCtx.agent.goal.createGoal({
      objective: 'Do not clear without a record',
    });
    const publishedBeforeClear = publishedGoalEventCount(clearCtx.allEvents);
    clearStore.failOn('goal.clear');

    await expect(clearCtx.agent.goal.cancelGoal()).rejects.toThrow(
      'record append failed for goal.clear',
    );

    expect(clearCtx.agent.goal.getGoal().goal).toMatchObject({
      goalId: retained.goalId,
      status: 'active',
    });
    expect(publishedGoalEventCount(clearCtx.allEvents)).toBe(publishedBeforeClear);
  });

  it('does not clear a replacement created by a completion event consumer', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.goal.createGoal({ objective: 'Complete the original goal' });
    const publish = ctx.agent.emitEvent.bind(ctx.agent);
    let replacementCreation: Promise<unknown> | undefined;
    vi.spyOn(ctx.agent, 'emitEvent').mockImplementation((event) => {
      publish(event);
      if (event.type !== 'goal.updated' || event.change?.kind !== 'completion') return;
      replacementCreation = ctx.agent.goal.createGoal({
        objective: 'Replacement from completion consumer',
        replace: true,
      });
    });

    await ctx.agent.goal.markComplete({ reason: 'Original work finished' });
    await replacementCreation;

    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      objective: 'Replacement from completion consumer',
      status: 'active',
    });
    const goalRecords = ctx.allEvents.filter(
      (event) =>
        event.type === '[wire]' &&
        (event.event === 'goal.create' ||
          event.event === 'goal.update' ||
          event.event === 'goal.clear'),
    );
    expect(goalRecords.map((event) => event.event)).toEqual([
      'goal.create',
      'goal.update',
      'goal.create',
    ]);
  });

  it('rejects an oversized completion criterion without replacing the current goal', async () => {
    const ctx = testAgent();
    const original = await ctx.agent.goal.createGoal({ objective: 'Keep the current goal' });

    await expect(
      ctx.agent.goal.createGoal({
        objective: 'Invalid replacement',
        completionCriterion: 'x'.repeat(4001),
        replace: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.GOAL_COMPLETION_CRITERION_TOO_LONG });
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      goalId: original.goalId,
      objective: 'Keep the current goal',
    });

    const replacement = await ctx.agent.goal.createGoal({
      objective: 'Valid replacement',
      completionCriterion: 'x'.repeat(4000),
      replace: true,
    });
    expect(replacement.completionCriterion).toHaveLength(4000);
  });

  it('bounds oversized persisted goal text during replay', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const original = testAgent({ persistence });
    original.configure();
    original.agent.records.logRecord({
      type: 'goal.create',
      goalId: 'legacy-goal',
      objective: `  ${'o'.repeat(5000)}  `,
      completionCriterion: 'x'.repeat(5000),
    });
    original.agent.records.logRecord({
      type: 'goal.update',
      status: 'blocked',
      reason: `  ${'r'.repeat(1200)}  `,
    });

    const resumed = testAgent({ persistence });
    await resumed.agent.resume();

    expect(resumed.agent.goal.getGoal().goal).toMatchObject({
      goalId: 'legacy-goal',
      status: 'blocked',
    });
    expect(resumed.agent.goal.getGoal().goal?.objective).toHaveLength(4000);
    expect(resumed.agent.goal.getGoal().goal?.completionCriterion).toHaveLength(4000);
    expect(resumed.agent.goal.getGoal().goal?.terminalReason).toHaveLength(1000);
  });

  it('ignores a persisted goal whose objective has no usable text', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const original = testAgent({ persistence });
    original.configure();
    original.agent.records.logRecord({
      type: 'goal.create',
      goalId: 'empty-legacy-goal',
      objective: ' \t\n ',
    });

    const resumed = testAgent({ persistence });
    await resumed.agent.resume();

    expect(resumed.agent.goal.getGoal().goal).toBeNull();
  });

  it('does not let malformed replay updates roll back progress or budgets', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const original = testAgent({ persistence });
    original.configure();
    original.agent.records.logRecord({
      type: 'goal.create',
      goalId: 'malformed-update-goal',
      objective: 'Preserve valid restored progress',
    });
    original.agent.records.logRecord({
      type: 'goal.update',
      status: 'paused',
      reason: 'Valid pause reason',
      turnsUsed: 5,
      tokensUsed: 25,
      wallClockMs: 500,
      budgetLimits: {
        tokenBudget: 100,
        turnBudget: 10,
        wallClockBudgetMs: 1000,
      },
    });
    original.agent.records.logRecord({
      type: 'goal.update',
      status: 'corrupt' as GoalStatus,
      reason: 'Must not replace the valid reason',
      turnsUsed: -4,
      tokensUsed: -10,
      wallClockMs: -50,
      budgetLimits: {
        tokenBudget: -1,
        turnBudget: 1.5,
        wallClockBudgetMs: Number.MAX_SAFE_INTEGER + 1,
      },
    });

    const resumed = testAgent({ persistence });
    await resumed.agent.resume();

    expect(resumed.agent.goal.getGoal().goal).toMatchObject({
      goalId: 'malformed-update-goal',
      status: 'paused',
      terminalReason: 'Valid pause reason',
      turnsUsed: 5,
      tokensUsed: 25,
      wallClockMs: 500,
      budget: {
        tokenBudget: 100,
        turnBudget: 10,
        wallClockBudgetMs: 1000,
        remainingTokens: 75,
        remainingTurns: 5,
        remainingWallClockMs: 500,
      },
    });
  });

  it('rejects invalid limits without changing the stored budget', async () => {
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Stay within budget' });
    await ctx.agent.goal.setBudgetLimits({ budgetLimits: { tokenBudget: 100 } });
    const invalidLimits: readonly GoalBudgetLimits[] = [
      { tokenBudget: 0 },
      { tokenBudget: -1 },
      { tokenBudget: Number.NaN },
      { tokenBudget: Number.POSITIVE_INFINITY },
      { turnBudget: 1.5 },
      { wallClockBudgetMs: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const budgetLimits of invalidLimits) {
      await expect(ctx.agent.goal.setBudgetLimits({ budgetLimits })).rejects.toMatchObject({
        code: ErrorCodes.GOAL_BUDGET_INVALID,
      });
      expect(ctx.agent.goal.getGoal().goal?.budget).toMatchObject({
        tokenBudget: 100,
        turnBudget: null,
        wallClockBudgetMs: null,
      });
    }
  });

  it('rounds converted time units and rejects invalid public RPC values', async () => {
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Stay within budget' });

    const snapshot = await ctx.rpc.setGoalBudget({ value: 1.5004, unit: 'seconds' });
    expect(snapshot.budget.wallClockBudgetMs).toBe(1500);

    await expect(
      ctx.rpc.setGoalBudget({ value: -1, unit: 'tokens' }),
    ).rejects.toMatchObject({ code: ErrorCodes.GOAL_BUDGET_INVALID });
    expect(ctx.agent.goal.getGoal().goal?.budget.wallClockBudgetMs).toBe(1500);
  });

  it('preserves active elapsed time when replay pauses an interrupted goal', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const persistence = new InMemoryAgentRecordPersistence();
    const original = testAgent({ persistence });
    original.configure();
    await original.agent.goal.createGoal({ objective: 'Survive process recovery' });
    await original.agent.goal.setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 10_000 } });

    now = 6_000;
    await original.agent.goal.recordTokenUsage(25);
    const recordCountBeforeResume = persistence.records.length;

    const resumed = testAgent({ persistence });
    await resumed.agent.resume();

    expect(resumed.agent.goal.getGoal().goal).toMatchObject({
      objective: 'Survive process recovery',
      status: 'paused',
      tokensUsed: 25,
      wallClockMs: 5_000,
      budget: {
        wallClockBudgetMs: 10_000,
        remainingWallClockMs: 5_000,
      },
      terminalReason: 'Paused after agent resume',
    });
    expect(persistence.records).toHaveLength(recordCountBeforeResume + 1);
    expect(persistence.records.at(-1)).toMatchObject({
      type: 'goal.update',
      status: 'paused',
      reason: 'Paused after agent resume',
    });
    expect(
      resumed.allEvents.filter(
        (event) => event.type === '[rpc]' && event.event === 'goal.updated',
      ),
    ).toHaveLength(0);

    const resumedAgain = testAgent({ persistence });
    await resumedAgain.agent.resume();

    expect(resumedAgain.agent.goal.getGoal().goal?.status).toBe('paused');
    expect(persistence.records).toHaveLength(recordCountBeforeResume + 1);
  });

  it('clears a trailing complete goal during replay without writing or emitting', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const original = testAgent({ persistence });
    original.configure();
    original.agent.records.logRecord({
      type: 'goal.create',
      goalId: 'completed-before-clear',
      objective: 'Already completed',
    });
    original.agent.records.logRecord({
      type: 'goal.update',
      status: 'complete',
      reason: 'Completed before the process stopped',
    });
    const recordCountBeforeResume = persistence.records.length;

    const resumed = testAgent({ persistence });
    await resumed.agent.resume();

    expect(resumed.agent.goal.getGoal().goal).toBeNull();
    expect(persistence.records).toHaveLength(recordCountBeforeResume);
    expect(
      resumed.allEvents.filter(
        (event) => event.type === '[rpc]' && event.event === 'goal.updated',
      ),
    ).toHaveLength(0);

    const resumedAgain = testAgent({ persistence });
    await resumedAgain.agent.resume();

    expect(resumedAgain.agent.goal.getGoal().goal).toBeNull();
    expect(persistence.records).toHaveLength(recordCountBeforeResume);
  });

  it('attributes late usage to the captured goal without charging its replacement', async () => {
    const ctx = testAgent();
    const original = await ctx.agent.goal.createGoal({ objective: 'Original goal' });

    await ctx.agent.goal.pauseGoal();
    await ctx.agent.goal.recordTokenUsageForGoal(original.goalId, 25);

    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      goalId: original.goalId,
      status: 'paused',
      tokensUsed: 25,
    });

    const replacement = await ctx.agent.goal.createGoal({
      objective: 'Replacement goal',
      replace: true,
    });
    await ctx.agent.goal.recordTokenUsageForGoal(original.goalId, 50);

    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
      tokensUsed: 0,
    });
  });

  it('persists goal notes, emits goal.updated, and restores them across session replay', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const original = testAgent({ persistence });
    original.configure();

    const goal = await original.agent.goal.createGoal({ objective: 'Test note durability' });
    expect(goal.notes).toEqual([]);

    const initialEventCount = publishedGoalEventCount(original.allEvents);

    const snapshot = await original.agent.goal.addNote('Verified endpoint structure');
    expect(snapshot?.notes).toHaveLength(1);
    expect(snapshot?.notes[0]?.content).toBe('Verified endpoint structure');
    expect(publishedGoalEventCount(original.allEvents)).toBe(initialEventCount + 1);

    const recordWireEvents = original.allEvents.filter(
      (e) => e.type === '[wire]' && e.event === 'goal.update',
    );
    expect(recordWireEvents.length).toBeGreaterThan(0);

    const resumed = testAgent({ persistence });
    await resumed.agent.resume();

    const restoredGoal = resumed.agent.goal.getGoal().goal;
    expect(restoredGoal).not.toBeNull();
    expect(restoredGoal?.notes).toHaveLength(1);
    expect(restoredGoal?.notes[0]?.content).toBe('Verified endpoint structure');
  });
});

function publishedGoalEventCount(
  events: readonly { readonly type: string; readonly event: string }[],
): number {
  return events.filter(
    (event) => event.type === '[rpc]' && event.event === 'goal.updated',
  ).length;
}

function controllablePersistence(): {
  readonly persistence: AgentRecordPersistence;
  failOn(type: AgentRecord['type'] | undefined): void;
} {
  const records: AgentRecord[] = [];
  let failedType: AgentRecord['type'] | undefined;
  return {
    persistence: {
      async *read(): AsyncIterable<AgentRecord> {
        for (const record of records) yield record;
      },
      append(record): void {
        if (record.type === failedType) {
          throw new Error(`record append failed for ${record.type}`);
        }
        records.push(record);
      },
      rewrite(nextRecords): void {
        records.splice(0, records.length, ...nextRecords);
      },
      async flush(): Promise<void> {},
      async close(): Promise<void> {},
    },
    failOn(type): void {
      failedType = type;
    },
  };
}
