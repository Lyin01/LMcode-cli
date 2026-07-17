import type { Agent } from '#/agent';
import { z } from 'zod';

import {
  GOAL_BLOCKED_REMINDER_NAME,
  GOAL_COMPLETION_REMINDER_NAME,
} from '../../../agent/goal';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
  buildGradingFeedbackPrompt,
} from './outcome-prompts';
import type { BuiltinTool } from '../../../agent/tool';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export type GoalGraderFn = (
  objective: string,
  criterion: string | undefined,
  output: string,
  signal: AbortSignal,
) => Promise<{ pass: boolean; reason: string }>;

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'paused', 'blocked'])
      .describe('The lifecycle status to set for the current goal.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

const MAX_GRADER_OUTPUT_CHARS = 4000;

function extractRecentOutput(history: readonly { role: string; content: { type: string; text?: string }[] }[]): string {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined || msg.role !== 'assistant') continue;
    const text = msg.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (text) parts.unshift(text);
    const total = parts.join('\n\n');
    if (total.length >= MAX_GRADER_OUTPUT_CHARS) break;
  }
  const joined = parts.join('\n\n');
  // Keep the newest tail: the final assistant messages carry the completion
  // evidence the grader needs; the head is the stale part to drop.
  return joined.length > MAX_GRADER_OUTPUT_CHARS ? `…${joined.slice(-MAX_GRADER_OUTPUT_CHARS)}` : joined;
}

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description = "Update the current goal's lifecycle status. Use `complete` when the goal is achieved, `blocked` when you cannot proceed, `paused` to park it, or `active` to resume.";
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly grader: GoalGraderFn,
  ) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    const goal = this.agent.goal;

    return {
      description: `Setting goal status: ${args.status}`,
      approvalRule: this.name,
      execute: async (ctx) => {
        if (args.status === 'active') {
          await goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (args.status === 'complete') {
          return this.handleComplete(goal, ctx.signal);
        }
        if (args.status === 'blocked') {
          const blocked = await goal.markBlocked({}, 'model');
          if (blocked !== null) {
            this.agent.context.appendSystemReminder(buildGoalBlockedReasonPrompt(blocked), {
              kind: 'system_trigger',
              name: GOAL_BLOCKED_REMINDER_NAME,
            });
          }
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        await goal.pauseGoal({}, 'model');
        return { output: 'Goal paused.', stopTurn: true };
      },
    };
  }

  private async handleComplete(
    goal: Agent['goal'],
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const goalState = goal.getGoal().goal;
    if (!goalState) return { output: 'No active goal.' };

    const output = extractRecentOutput(this.agent.context.history);

    // Pause goal to prevent continuation loop from interfering during grading
    await goal.pauseGoal({ reason: 'verifying' }, 'system');

    let pass: boolean;
    let reason: string;
    try {
      const result = await this.grader(
        goalState.objective,
        goalState.completionCriterion,
        output,
        signal,
      );
      signal.throwIfAborted();
      pass = result.pass;
      reason = result.reason;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      this.agent.log.warn('goal completion grader failed', { error });
      pass = false;
      reason =
        'Goal verification could not be completed because the grader was unavailable. Completion remains unverified.';
    } finally {
      const current = goal.getGoal().goal;
      if (
        current?.goalId === goalState.goalId &&
        current.status === 'paused' &&
        current.terminalReason === 'verifying'
      ) {
        await goal.resumeGoal({}, 'system');
      }
    }

    const current = goal.getGoal().goal;
    if (current?.goalId !== goalState.goalId || current.status !== 'active') {
      return {
        isError: true,
        output: 'Goal changed while completion verification was running. The grader verdict was discarded.',
      };
    }

    if (pass) {
      const completed = await goal.markComplete({}, 'model');
      if (completed === null) {
        return {
          isError: true,
          output: 'Goal changed before completion could be recorded. The grader verdict was discarded.',
        };
      }
      this.agent.context.appendSystemReminder(buildGoalCompletionSummaryPrompt(completed), {
        kind: 'system_trigger',
        name: GOAL_COMPLETION_REMINDER_NAME,
      });
      return { output: `Goal verified and marked complete.\n${reason}`, stopTurn: true };
    }

    this.agent.context.appendSystemReminder(buildGradingFeedbackPrompt(reason), {
      kind: 'system_trigger',
      name: 'goal_grading_feedback',
    });
    return { output: `Verification failed: ${reason}. Continue working.` };
  }
}
