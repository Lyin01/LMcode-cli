import type { ContextMessage } from '@lmcode-cli/lmcode-sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/lmcode-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { replaceTabs } from '../utils/render-text';
import type { SlashCommandHost } from './dispatch';

// ── Revoke command ────────────────────────────────────────────────────────

export async function handleRevokeCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('无法在 streaming 中撤回 — 请先按 Esc 或 Ctrl-C 取消。');
    return;
  }

  const count = parseRevokeCount(args);
  if (count === undefined) {
    host.showError('用法：/revoke [数量]，数量为正整数。');
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  let availableCount: number;
  try {
    const context = await session.getContext();
    availableCount = countUndoableUserPrompts(context.history);
  } catch (error) {
    const message = replaceTabs(formatErrorMessage(error));
    host.showError(`撤回失败：${message}`);
    return;
  }
  if (availableCount === 0) {
    host.showError('没有可以撤回的内容。');
    return;
  }
  const undoCount = Math.min(count, availableCount);

  const entries = host.state.transcriptEntries;
  const lastUserIndex = findRevokeAnchorEntryIndex(entries, undoCount);
  // A missing anchor is NOT an error when core history holds more prompts
  // than the 10-turn transcript projection shows: the rebuild path below
  // re-hydrates the remaining history after the undo.

  try {
    await session.undoHistory(undoCount);
  } catch (error) {
    const message = replaceTabs(formatErrorMessage(error));
    host.showError(`撤回失败：${message}`);
    return;
  }

  if (lastUserIndex !== undefined) {
    const preservedEntries = entries.slice(lastUserIndex).filter(
      (entry) => !isRevokeContextEntry(entry),
    );
    const remainingEntries = [
      ...entries.slice(0, lastUserIndex),
      ...preservedEntries,
    ];
    // The slice is authoritative only while it still mirrors core history:
    // context entries survived the cut, or core had nothing left to show.
    if (
      remainingEntries.some((entry) => isRevokeContextEntry(entry)) ||
      availableCount === undoCount
    ) {
      host.transcriptController.replaceEntriesAndRebuild(remainingEntries);
      if (remainingEntries.length === 0 && availableCount === undoCount) {
        host.transcriptController.renderWelcome();
      }
      return;
    }
    // Otherwise fall through: the visible window is exhausted but core
    // still holds older prompts that were never displayed.
  }

  // Re-hydrate from the remaining core history instead of leaving an
  // empty (or misleadingly short) transcript.
  try {
    const fresh = await session.getContext();
    host.transcriptController.replaceEntriesAndRebuild([]);
    if (fresh.history.length === 0) {
      host.transcriptController.renderWelcome();
      return;
    }
    host.sessionReplay.rebuildFromHistory(fresh.history);
  } catch (error) {
    const message = replaceTabs(formatErrorMessage(error));
    host.showError(`撤回后重建会话记录失败：${message}`);
  }
}
// ── Parsing ─────────────────────────────────────────────────────────────

function parseRevokeCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

// ── Transcript entry helpers ─────────────────────────────────────────────

function isRevokeAnchorEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'user' ||
    (entry.kind === 'skill_activation' &&
      (entry.skillTrigger === undefined || entry.skillTrigger === 'user-slash'))
  );
}

function countUndoableUserPrompts(history: readonly ContextMessage[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'compaction_summary') break;
    if (message.role !== 'user') continue;
    if (message.origin === undefined || message.origin.kind === 'user') {
      count++;
      continue;
    }
    if (
      message.origin.kind === 'skill_activation' &&
      message.origin.trigger === 'user-slash'
    ) {
      count++;
    }
  }
  return count;
}

function findRevokeAnchorEntryIndex(
  entries: readonly TranscriptEntry[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isRevokeAnchorEntry(entry)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function isRevokeContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'thinking':
    case 'skill_activation':
      return true;
    case 'status':
      return entry.turnId !== undefined;
    case 'welcome':
    case 'cron':
      return false;
  }
}
