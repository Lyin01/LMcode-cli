/**
 * Pure reporting helpers: turn `RunResult[]` into an aggregate summary and a
 * printable text table. Kept side-effect-free (no console writes) so the logic
 * is unit-testable; `run.ts` does the actual printing.
 */

import type { RunResult } from './types';

export interface Aggregate {
  readonly total: number;
  readonly ran: number;
  readonly skipped: number;
  readonly passed: number;
  readonly failed: number;
  /** Pass-rate over *ran* (non-skipped) tasks, in [0, 1]. NaN-safe → 0. */
  readonly passRate: number;
  /** True when every non-skipped task passed (vacuously true if none ran). */
  readonly allPassed: boolean;
}

export function aggregate(results: readonly RunResult[]): Aggregate {
  const ran = results.filter((r) => !r.skipped);
  const skipped = results.length - ran.length;
  const passed = ran.filter((r) => r.passed).length;
  const failed = ran.length - passed;
  return {
    total: results.length,
    ran: ran.length,
    skipped,
    passed,
    failed,
    passRate: ran.length === 0 ? 0 : passed / ran.length,
    allPassed: failed === 0,
  };
}

function statusCell(result: RunResult): string {
  if (result.skipped) return 'SKIP';
  return result.passed ? 'PASS' : 'FAIL';
}

function tokensCell(result: RunResult): string {
  if (result.skipped) return '-';
  if (!result.tokens) return 'n/a';
  return String(result.tokens.total);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Format a results table as a plain-text string. Columns: task id, status,
 * score, duration, tokens.
 */
export function formatTable(results: readonly RunResult[]): string {
  const header = ['TASK', 'STATUS', 'SCORE', 'DURATION', 'TOKENS'];
  const rows = results.map((r) => [
    r.taskId,
    statusCell(r),
    r.skipped ? '-' : r.score.toFixed(2),
    r.skipped ? '-' : `${(r.durationMs / 1000).toFixed(2)}s`,
    tokensCell(r),
  ]);

  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((row) => (row[col] ?? '').length)),
  );

  const renderRow = (cells: readonly string[]): string =>
    cells.map((c, col) => pad(c, widths[col] ?? c.length)).join('  ');

  const divider = widths.map((w) => '-'.repeat(w)).join('  ');
  return [renderRow(header), divider, ...rows.map(renderRow)].join('\n');
}

/** One-line aggregate summary, e.g. `2 ran, 2 passed, 0 failed (100%), 1 skipped`. */
export function formatSummary(agg: Aggregate): string {
  const pct = `${Math.round(agg.passRate * 100)}%`;
  return `${agg.ran} ran, ${agg.passed} passed, ${agg.failed} failed (${pct}), ${agg.skipped} skipped`;
}

/** Detail lines for failed/errored/skipped tasks, for printing under the table. */
export function formatDetails(results: readonly RunResult[]): string {
  const notable = results.filter((r) => r.skipped || !r.passed);
  if (notable.length === 0) return '';
  return notable
    .map((r) => {
      const label = r.skipped ? 'SKIP' : 'FAIL';
      const why = r.error ? `${r.details} (error: ${r.error})` : r.details;
      return `  [${label}] ${r.taskId}: ${why}`;
    })
    .join('\n');
}
