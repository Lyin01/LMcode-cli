/**
 * Eval harness entry point. Run with:
 *   pnpm eval                      # all tasks (real ones skip without a model)
 *   pnpm eval smoke-plumbing       # just one task by id
 *   pnpm eval smoke-plumbing fix-failing-fn
 *
 * Exits non-zero iff any non-skipped task failed (so it's CI-friendly). Skipped
 * tasks (e.g. real-model tasks with no model configured) never fail the run.
 */

import {
  aggregate,
  fakeProviderSetup,
  formatDetails,
  formatSummary,
  formatTable,
  resolveRealModel,
  runTask,
  skippedResult,
  startFakeProvider,
  type RunResult,
  type Task,
} from './framework';
import { fixFailingFnTask } from './tasks/fix-failing-fn';
import { smokePlumbingTask } from './tasks/smoke-plumbing';

const ALL_TASKS: readonly Task[] = [smokePlumbingTask, fixFailingFnTask];

function selectTasks(argv: readonly string[]): Task[] {
  const filters = argv.filter((a) => !a.startsWith('-'));
  if (filters.length === 0) return [...ALL_TASKS];

  const byId = new Map(ALL_TASKS.map((t) => [t.id, t]));
  const selected: Task[] = [];
  for (const id of filters) {
    const task = byId.get(id);
    if (!task) {
      console.error(`Unknown task id: "${id}". Known: ${[...byId.keys()].join(', ')}`);
      process.exit(2);
    }
    selected.push(task);
  }
  return selected;
}

async function runFakeTask(task: Task): Promise<RunResult> {
  const server = await startFakeProvider({ responseText: 'Acknowledged — plumbing smoke OK.' });
  try {
    return await runTask({ task, provider: fakeProviderSetup(server.baseUrl) });
  } finally {
    await server.close().catch(() => {});
  }
}

async function runRealTask(task: Task): Promise<RunResult> {
  const resolution = resolveRealModel();
  if (!resolution.setup) {
    return skippedResult(task, resolution.skipReason ?? 'real model not configured');
  }
  return runTask({ task, provider: resolution.setup });
}

async function main(): Promise<void> {
  const tasks = selectTasks(process.argv.slice(2));
  console.log(`Running ${tasks.length} eval task(s): ${tasks.map((t) => t.id).join(', ')}\n`);

  const results: RunResult[] = [];
  for (const task of tasks) {
    process.stdout.write(`→ ${task.id} (${task.kind}) ... `);
    const result = task.kind === 'fake' ? await runFakeTask(task) : await runRealTask(task);
    const status = result.skipped ? 'SKIP' : result.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`${status}\n`);
    results.push(result);
  }

  const agg = aggregate(results);
  console.log(`\n${formatTable(results)}\n`);
  const details = formatDetails(results);
  if (details) console.log(`${details}\n`);
  console.log(formatSummary(agg));

  // Fail the process iff a non-skipped task failed.
  process.exit(agg.allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Eval harness crashed:', error);
  process.exit(1);
});
