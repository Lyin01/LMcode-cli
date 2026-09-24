import { normalizeMemoKind, type MemoryMemoSummary } from '@lmcode/memory';

import { DynamicInjector, FRESH_SESSION_MAX_HISTORY } from './injector';
import { formatSessionAge } from './recent-sessions';

/** How many pending tasks one injection may carry. */
export const PENDING_TASK_INJECTION_LIMIT = 3;

/** How many recent pending memos to scan before stale entries drop out. */
export const PENDING_TASK_SCAN_LIMIT = 12;

/** Pending tasks older than this stop being surfaced. */
export const PENDING_TASK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const MAX_TASK_CHARS = 100;
const MAX_PROGRESS_CHARS = 180;

export interface PendingTaskLinesOptions {
  readonly now: number;
  readonly limit?: number | undefined;
}

/**
 * Render pending-task memos as the bullet list injected into a fresh session.
 * Stale entries (older than `PENDING_TASK_MAX_AGE_MS`) and memos of any other
 * kind are skipped.
 */
export function renderPendingTaskLines(
  memos: readonly MemoryMemoSummary[],
  options: PendingTaskLinesOptions,
): string {
  const limit = options.limit ?? PENDING_TASK_INJECTION_LIMIT;
  const lines: string[] = [];
  for (const memo of memos) {
    if (lines.length >= limit) break;
    if (normalizeMemoKind(memo.kind) !== 'pending') continue;
    if (options.now - memo.recordedAt > PENDING_TASK_MAX_AGE_MS) continue;

    const task = truncateTail(memo.userNeed.trim(), MAX_TASK_CHARS);
    if (task.length === 0) continue;
    const progress = truncateTail(memo.approach.replace(/\s+/g, ' ').trim(), MAX_PROGRESS_CHARS);
    const detail = progress.length > 0 ? ` · 进度：${progress}` : '';
    lines.push(`- ${task}${detail}（${formatSessionAge(options.now, memo.recordedAt)}）`);
  }
  return lines.join('\n');
}

function truncateTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * Surfaces the user's unfinished tasks at the start of a fresh session, so
 * interrupted work can be resumed without re-explaining it.
 *
 * Shares the fresh-session window with `RecentSessionsInjector`: a resumed
 * session already carries its own context, and each session is briefed at
 * most once.
 */
export class PendingTasksInjector extends DynamicInjector {
  override readonly injectionVariant = 'pending_tasks';
  private hasPublished = false;

  protected override async getInjection(): Promise<string | undefined> {
    if (this.hasPublished) return undefined;
    if (this.agent.type !== 'main') return undefined;
    if (this.agent.context.history.length > FRESH_SESSION_MAX_HISTORY) return undefined;

    let rendered: string;
    try {
      rendered = await this.agent.renderPendingTasks();
    } catch {
      return undefined;
    }
    if (rendered.length === 0) return undefined;

    this.hasPublished = true;
    return [
      '用户有未完成的工作（来自此前会话的记忆）：',
      '',
      rendered,
      '',
      '如果用户提到"继续"或相关任务，可以直接从这里接着做。当用户确认某项已完成时，先调用 MemoryLookup 找到该条记录，再用 MemoryEdit 更新或删除它；与当前话题无关时忽略即可。',
    ].join('\n');
  }
}
