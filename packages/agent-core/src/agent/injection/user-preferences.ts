import { normalizeMemoKind, type MemoryMemoSummary } from '@lmcode/memory';

import { DynamicInjector } from './injector';

/** How many preference memos one injection may carry. */
export const USER_PREFERENCE_INJECTION_LIMIT = 12;

/**
 * Render preference memos as the bullet list injected into the session
 * context. The rule text is `approach`; `userNeed` is only a fallback for
 * records that predate the preference shape.
 */
export function renderUserPreferenceLines(memos: readonly MemoryMemoSummary[]): string {
  const lines: string[] = [];
  for (const memo of memos) {
    if (normalizeMemoKind(memo.kind) !== 'preference') continue;
    const rule = memo.approach.trim() || memo.userNeed.trim();
    if (rule.length === 0) continue;
    const tags =
      memo.tags !== undefined && memo.tags.length > 0 ? `（${memo.tags.join('、')}）` : '';
    lines.push(`- ${rule}${tags}`);
  }
  return lines.join('\n');
}

/**
 * Keeps the user's stable preferences in context.
 *
 * Unlike the session-context digest — which is written once and consumed by the
 * first compaction — this injector re-publishes the preferences whenever the
 * rendered list changes or the previous injection no longer exists in the
 * history. A habit learned mid-session, or one compacted away, therefore comes
 * back on the next turn instead of silently disappearing.
 */
export class UserPreferencesInjector extends DynamicInjector {
  override readonly injectionVariant = 'user_preferences';
  private lastInjected: string | null = null;

  override onContextClear(): void {
    super.onContextClear();
    this.lastInjected = null;
  }

  protected override async getInjection(): Promise<string | undefined> {
    // Subagents follow the main agent's instructions; repeating the user's
    // preference digest in every child context only burns tokens.
    if (this.agent.type !== 'main') return undefined;

    let rendered: string;
    try {
      rendered = await this.agent.renderUserPreferences();
    } catch {
      return undefined;
    }
    if (rendered.length === 0) return undefined;

    // Position 0 means the tracked message cannot still be the injected one
    // (a compaction shifted it there or consumed it) — re-publish instead of
    // trusting a stale position.
    if (rendered === this.lastInjected && this.injectedAt !== null && this.injectedAt > 0) {
      return undefined;
    }

    this.lastInjected = rendered;
    return [
      '该用户的长期偏好与习惯（来自历史会话的记忆）：',
      '',
      rendered,
      '',
      '请默认遵循以上偏好；如果用户在当前会话中提出不同要求，以当前要求为准。',
      '当用户明确要求"记住"一条新偏好、或纠正一条旧偏好时，调用 MemoryWrite 工具并把 kind 设为 "preference" 更新记忆。',
    ].join('\n');
  }
}
