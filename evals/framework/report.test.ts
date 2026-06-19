import { describe, expect, it } from 'vitest';

import { aggregate, formatDetails, formatSummary, formatTable } from './report';
import type { RunResult } from './types';

function result(overrides: Partial<RunResult>): RunResult {
  return {
    taskId: 'task',
    description: 'desc',
    kind: 'fake',
    skipped: false,
    passed: true,
    score: 1,
    details: 'ok',
    durationMs: 1000,
    ...overrides,
  };
}

describe('aggregate', () => {
  it('counts passed/failed over ran tasks and ignores skipped', () => {
    const agg = aggregate([
      result({ taskId: 'a', passed: true }),
      result({ taskId: 'b', passed: false }),
      result({ taskId: 'c', skipped: true, passed: false }),
    ]);
    expect(agg).toEqual({
      total: 3,
      ran: 2,
      skipped: 1,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      allPassed: false,
    });
  });

  it('reports allPassed=true when only skipped/passed tasks exist', () => {
    const agg = aggregate([
      result({ taskId: 'a', passed: true }),
      result({ taskId: 'b', skipped: true, passed: false }),
    ]);
    expect(agg.allPassed).toBe(true);
    expect(agg.passRate).toBe(1);
  });

  it('is NaN-safe with zero ran tasks (vacuous pass)', () => {
    const agg = aggregate([result({ skipped: true, passed: false })]);
    expect(agg.ran).toBe(0);
    expect(agg.passRate).toBe(0);
    expect(agg.allPassed).toBe(true);
  });

  it('handles an empty result set', () => {
    const agg = aggregate([]);
    expect(agg.total).toBe(0);
    expect(agg.allPassed).toBe(true);
    expect(agg.passRate).toBe(0);
  });
});

describe('formatTable', () => {
  it('renders aligned rows with status, score, duration, tokens', () => {
    const table = formatTable([
      result({
        taskId: 'smoke',
        passed: true,
        score: 1,
        durationMs: 820,
        tokens: { input: 11, output: 7, total: 18 },
      }),
      result({ taskId: 'gated', skipped: true, passed: false }),
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('TASK');
    expect(lines[0]).toContain('TOKENS');
    expect(table).toContain('PASS');
    expect(table).toContain('0.82s');
    expect(table).toContain('18');
    expect(table).toContain('SKIP');
  });

  it('shows n/a tokens when a ran task reports none', () => {
    const table = formatTable([result({ tokens: undefined })]);
    expect(table).toContain('n/a');
  });
});

describe('formatSummary', () => {
  it('formats the one-line aggregate', () => {
    const agg = aggregate([
      result({ taskId: 'a', passed: true }),
      result({ taskId: 'b', passed: false }),
      result({ taskId: 'c', skipped: true, passed: false }),
    ]);
    expect(formatSummary(agg)).toBe('2 ran, 1 passed, 1 failed (50%), 1 skipped');
  });
});

describe('formatDetails', () => {
  it('lists only failed and skipped tasks with reasons', () => {
    const details = formatDetails([
      result({ taskId: 'a', passed: true }),
      result({ taskId: 'b', passed: false, details: 'check failed' }),
      result({ taskId: 'c', skipped: true, details: 'no model' }),
      result({ taskId: 'd', passed: false, details: 'boom', error: 'crash' }),
    ]);
    expect(details).not.toContain(' a:');
    expect(details).toContain('[FAIL] b: check failed');
    expect(details).toContain('[SKIP] c: no model');
    expect(details).toContain('[FAIL] d: boom (error: crash)');
  });

  it('returns empty string when everything passed', () => {
    expect(formatDetails([result({ passed: true })])).toBe('');
  });
});
