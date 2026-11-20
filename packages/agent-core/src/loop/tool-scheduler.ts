/**
 * Stateful execution scheduler for tool calls in one model step.
 *
 * The scheduler owns only execution ordering:
 *   - tasks with non-conflicting resource accesses may overlap
 *   - tasks with conflicting resource accesses wait for the conflicting active tasks
 *   - drained results are handed back in provider order
 *
 * Validation, hooks, event construction, and result finalization stay in
 * `tool-call.ts`.
 */

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';

import { ToolAccesses } from './tool-access';

// Scheduler

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccesses;
  readonly start: () => Promise<Result>;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: ControlledPromise<Result>;
}

export class ToolScheduler<Result> {
  private readonly activeTasks = new Set<ScheduledToolCallTask<Result>>();
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];
  private drainScheduled = false;

  add(task: ToolCallTask<Result>): Promise<Result> {
    const result = createControlledPromise<Result>();
    void result.catch(() => undefined);

    const scheduledTask: ScheduledToolCallTask<Result> = { ...task, result };
    if (this.isBlocked(task, this.queuedTasks)) {
      this.queuedTasks.push(scheduledTask);
    } else {
      void this.start(scheduledTask);
    }

    return result;
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: Iterable<ToolCallTask<Result>>,
  ): boolean {
    for (const candidate of candidates) {
      if (ToolAccesses.conflict(task.accesses, candidate.accesses)) return true;
    }
    return false;
  }

  private async start(task: ScheduledToolCallTask<Result>): Promise<void> {
    this.activeTasks.add(task);
    try {
      task.result.resolve(await task.start());
    } catch (error) {
      task.result.reject(error);
    } finally {
      this.activeTasks.delete(task);
      // Several readers can finish together. Defer their single queue pass
      // until after the current pass, including when start() throws synchronously.
      if (this.queuedTasks.length > 0 && !this.drainScheduled) {
        this.drainScheduled = true;
        queueMicrotask(() => {
          this.drainScheduled = false;
          this.startQueuedTasks();
        });
      }
    }
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        void this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}
