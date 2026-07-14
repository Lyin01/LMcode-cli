import { describe, expect, it, vi } from 'vitest';

import { parseGraderResponse } from '../../src/tools/builtin/goal/grader';
import { UpdateGoalTool } from '../../src/tools/builtin/goal/update-goal';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from './fixtures/execute-tool';

describe('goal completion grading', () => {
  it('rejects missing or malformed structured verdicts', () => {
    expect(parseGraderResponse('PASS').pass).toBe(false);
    expect(parseGraderResponse('{not valid json}').pass).toBe(false);
  });

  it('rejects an overall PASS that contradicts a failed dimension', () => {
    const result = parseGraderResponse(
      JSON.stringify({
        completeness: { pass: false, detail: 'One requirement is missing.' },
        conformance: { pass: true, detail: 'The implementation is in scope.' },
        substance: { pass: true, detail: 'The work is implemented.' },
        issues: ['Implement the missing requirement.'],
        pass: true,
        reason: 'Looks good overall.',
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('contradicts');
    expect(result.reason).toContain('Implement the missing requirement.');
  });

  it('rejects a PASS verdict that still reports unresolved issues', () => {
    const result = parseGraderResponse(
      JSON.stringify({
        completeness: { pass: true, detail: 'Every criterion has evidence.' },
        conformance: { pass: true, detail: 'The implementation is in scope.' },
        substance: { pass: true, detail: 'The work is implemented.' },
        issues: ['The cancellation path is still unverified.'],
        pass: true,
        reason: 'All dimensions passed.',
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('The cancellation path is still unverified.');
  });

  it('accepts only a complete, internally consistent PASS verdict', () => {
    const result = parseGraderResponse(
      JSON.stringify({
        completeness: { pass: true, detail: 'Every criterion has evidence.' },
        conformance: { pass: true, detail: 'The work matches the objective.' },
        substance: { pass: true, detail: 'Validation passed.' },
        issues: [],
        pass: true,
        reason: 'All criteria are met.',
      }),
    );

    expect(result.pass).toBe(true);
  });

  it('keeps the goal active when the grader is unavailable', async () => {
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Ship the complete feature' });
    const grader = vi.fn().mockRejectedValue(new Error('network unavailable'));
    const tool = new UpdateGoalTool(ctx.agent, grader);

    const result = await executeTool(tool, {
      turnId: 'turn-1',
      toolCallId: 'call-update-goal',
      signal: new AbortController().signal,
      args: { status: 'complete' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Verification failed');
    expect(result.output).toContain('grader was unavailable');
    expect(ctx.agent.goal.getGoal().goal?.status).toBe('active');
  });

  it('propagates cancellation while restoring the goal to active', async () => {
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Ship the complete feature' });
    const abortController = new AbortController();
    const grader = vi.fn(async () => {
      abortController.abort();
      abortController.signal.throwIfAborted();
      return { pass: true, reason: 'unreachable' };
    });
    const tool = new UpdateGoalTool(ctx.agent, grader);

    await expect(
      executeTool(tool, {
        turnId: 'turn-1',
        toolCallId: 'call-update-goal-abort',
        signal: abortController.signal,
        args: { status: 'complete' },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(ctx.agent.goal.getGoal().goal?.status).toBe('active');
  });

  it('does not complete a replacement goal created while grading', async () => {
    const ctx = testAgent();
    await ctx.agent.goal.createGoal({ objective: 'Original objective' });
    const grader = vi.fn(async () => {
      await ctx.agent.goal.createGoal({ objective: 'Replacement objective', replace: true });
      return { pass: true, reason: 'The original objective passed.' };
    });
    const tool = new UpdateGoalTool(ctx.agent, grader);

    const result = await executeTool(tool, {
      turnId: 'turn-1',
      toolCallId: 'call-update-goal-replaced',
      signal: new AbortController().signal,
      args: { status: 'complete' },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('grader verdict was discarded');
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      objective: 'Replacement objective',
      status: 'active',
    });
  });
});
