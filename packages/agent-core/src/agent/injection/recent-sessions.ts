import { basename } from 'pathe';

import type { SessionSummary } from '#/rpc/core-api';

import { DynamicInjector } from './injector';

/** How many recent sessions one briefing may carry. */
export const RECENT_SESSION_INJECTION_LIMIT = 5;

/**
 * History length above which the session is treated as resumed. A fresh
 * session holds nothing but the prompt that started the current turn (plus,
 * at most, the dream suggestion appended right before injections run), while
 * a resumed session replays its transcript into the history first.
 */
export const RECENT_SESSION_MAX_FRESH_HISTORY = 2;

const MAX_TITLE_CHARS = 80;
const MAX_PROMPT_CHARS = 120;
const MINUTE_MS = 60_000;

export interface RecentSessionLinesOptions {
  readonly selfSessionId?: string | undefined;
  readonly now: number;
  readonly limit?: number | undefined;
}

/** Format a session timestamp as an age relative to `now`. */
export function formatSessionAge(now: number, timestamp: number): string {
  const age = now - timestamp;
  if (!Number.isFinite(age)) return '未知时间';
  if (age < MINUTE_MS) return '刚刚';
  const minutes = Math.floor(age / MINUTE_MS);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Render recent sessions as the bullet list injected into a fresh session.
 * Archived sessions, sessions without a title or a recorded prompt, and the
 * current session itself carry no briefing value and are skipped.
 */
export function renderRecentSessionLines(
  sessions: readonly SessionSummary[],
  options: RecentSessionLinesOptions,
): string {
  const limit = options.limit ?? RECENT_SESSION_INJECTION_LIMIT;
  const lines: string[] = [];
  for (const session of sessions) {
    if (lines.length >= limit) break;
    if (session.archived === true) continue;
    if (options.selfSessionId !== undefined && session.id === options.selfSessionId) continue;

    const title = truncateTail(session.title?.trim() ?? '', MAX_TITLE_CHARS);
    const prompt =
      session.lastPrompt === undefined
        ? ''
        : truncateTail(session.lastPrompt.replace(/\s+/g, ' ').trim(), MAX_PROMPT_CHARS);
    if (title.length === 0 && prompt.length === 0) continue;

    const parts: string[] = [];
    if (title.length > 0) parts.push(title);
    if (prompt.length > 0) parts.push(`最后一句：「${prompt}」`);
    const project = basename(session.workDir);
    const projectPrefix = project.length > 0 ? `[${project}] ` : '';
    lines.push(
      `- ${projectPrefix}${parts.join(' · ')}（${formatSessionAge(options.now, session.updatedAt)}）`,
    );
  }
  return lines.join('\n');
}

function truncateTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * Briefs a fresh session on what the user was doing most recently, so a bare
 * "继续" still lands on the right task.
 *
 * Published at most once per session, and never into a session that already
 * replayed its own history: a resumed session does not need the briefing, and
 * later turns of the same session are past the point where it helps.
 */
export class RecentSessionsInjector extends DynamicInjector {
  override readonly injectionVariant = 'recent_sessions';
  private hasPublished = false;

  protected override async getInjection(): Promise<string | undefined> {
    if (this.hasPublished) return undefined;
    if (this.agent.type !== 'main') return undefined;
    if (this.agent.context.history.length > RECENT_SESSION_MAX_FRESH_HISTORY) return undefined;

    let rendered: string;
    try {
      rendered = await this.agent.renderRecentSessions();
    } catch {
      return undefined;
    }
    if (rendered.length === 0) return undefined;

    this.hasPublished = true;
    return [
      '以下是用户最近在其它会话中的活动摘要，供你了解用户可能想接着做什么：',
      '',
      rendered,
      '',
      '当用户提到"继续"、"接着上次的"等语时，结合这些记录判断所指的任务；如果对不上号，先向用户确认，不要凭空假设。',
    ].join('\n');
  }
}
