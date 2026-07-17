/**
 * Footer/status bar — single-line status display at the bottom of the TUI.
 *
 * Layout:
 *   [yolo] [plan] <model> <cwd> <git-badge>  context/cache/activity
 */

import type { Component, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, LivePaneMode } from '#/tui/types';
import { aliasHome } from '#/tui/utils/path-display';
import { shimmerText } from '#/tui/utils/shimmer';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import { safeUsageRatio } from '#/utils/usage/usage-format';

const MAX_CWD_SEGMENTS = 3;

function shortenModel(model: string): string {
  if (!model) return model;
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
}

function shortenCwd(path: string): string {
  const aliased = aliasHome(path);
  const segments = aliased.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return aliased;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = `${(safeUsage(usage) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `上下文：${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `上下文：${pct}`;
}

function formatPromptCacheStatus(ratio: number | null): string | null {
  if (ratio === null) return null;
  return `缓存：${(safeUsageRatio(ratio) * 100).toFixed(1)}%`;
}

// ── Gradient activity status ─────────────────────────────────────────

const BRAND_COLORS = ['#72A4E9', '#A78BFA', '#34D399'];
const GRADIENT_CYCLE_MS = 4000;
const SPINNER_FRAMES = ['●', '◉', '◎', '◌', '○', '◌', '◎', '◉'];
const SPINNER_TICK_MS = 120;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function lerpGradient(t: number): string {
  const count = BRAND_COLORS.length;
  const segment = Math.min(t * count, count - 1);
  const idx = Math.floor(segment);
  const localT = segment - idx;
  const nextIdx = (idx + 1) % count;
  const [r0, g0, b0] = hexToRgb(BRAND_COLORS[idx]!);
  const [r1, g1, b1] = hexToRgb(BRAND_COLORS[nextIdx]!);
  const r = Math.round(r0 + (r1 - r0) * localT);
  const g = Math.round(g0 + (g1 - g0) * localT);
  const b = Math.round(b0 + (b1 - b0) * localT);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function buildStatusLine(
  streamingPhase: AppState['streamingPhase'],
  livePaneMode: LivePaneMode,
  streamingStartTime: number,
): string {
  if (streamingPhase === 'idle' && livePaneMode !== 'tool') {
    return '○ 空闲';
  }

  let label: string;
  if (livePaneMode === 'tool') {
    label = '执行中';
  } else if (streamingPhase === 'waiting') {
    label = '等待响应';
  } else if (streamingPhase === 'thinking') {
    label = '思考中';
  } else if (streamingPhase === 'composing') {
    label = '输出中';
  } else {
    label = '';
  }

  const elapsed = Date.now() - streamingStartTime;
  const totalSeconds = Math.floor(elapsed / 1000);
  const elapsedStr = totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;

  const now = Date.now();
  const tick = Math.floor(now / SPINNER_TICK_MS);
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
  const gradientColor = lerpGradient((now % GRADIENT_CYCLE_MS) / GRADIENT_CYCLE_MS);

  // Only the spinner dot uses a brand gradient colour; the rest inherits
  // the line's outer colour so it stays consistent with the context text.
  return chalk.hex(gradientColor).bold(frame) + ' ' + label + ' ' + elapsedStr;
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.status)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private readonly ui: TUI;
  private readonly onGitStatusChange: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  private shimmerTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;
  constructor(state: AppState, colors: ColorPalette, ui: TUI, onGitStatusChange: () => void = () => {}) {
    this.state = state;
    this.colors = colors;
    this.ui = ui;
    this.onGitStatusChange = onGitStatusChange;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onGitStatusChange });
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onGitStatusChange });
    }
    this.state = state;
    // `appState` is Object.assign-patched before setState is called with the
    // same object, so a previous-vs-current edge comparison can never observe
    // a transition. Drive the timer off the current phase instead — both
    // helpers are idempotent.
    if (state.streamingPhase === 'thinking') {
      this.#startShimmer();
    } else {
      this.#stopShimmer();
    }
  }

  setColors(colors: ColorPalette): void {
    this.colors = colors;
  }

  /**
   * Short-lived hint that replaces the status area on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  invalidate(): void {}

  /**
   * Stop the shimmer animation timer. Idempotent — safe to call even when
   * the timer isn't running. Call this when the component is disposed.
   */
  dispose(): void {
    this.#stopShimmer();
  }

  // ── Shimmer animation ───────────────────────────────────────────────

  #startShimmer(): void {
    if (this.shimmerTimer) return;
    this.shimmerTimer = setInterval(() => {
      this.ui.requestRender();
    }, 1000 / 30);
  }

  #stopShimmer(): void {
    if (!this.shimmerTimer) return;
    clearInterval(this.shimmerTimer);
    this.shimmerTimer = null;
  }

  render(width: number): string[] {
    const colors = this.colors;
    const state = this.state;

    // ── Line 1: mode badges + model + [N task(s) running] + [N agent(s) running] + cwd + git + hints ──
    const left: string[] = [];
    if (state.permissionMode === 'auto') left.push(chalk.hex(colors.warning).bold('auto'));
    if (state.permissionMode === 'yolo') left.push(chalk.hex(colors.warning).bold('YES'));
    if (state.planMode) left.push(chalk.hex(colors.planMode).bold('plan'));
    if (state.wolfpackMode) left.push(chalk.hex(colors.primary).bold('wolfpack'));
    if (state.goalActive) {
      left.push(chalk.hex(colors.primary).bold('goal'));
    }

    const model = shortenModel(modelDisplayName(state));
    if (model) {
      if (state.streamingPhase === 'thinking') {
        left.push(shimmerText(model, colors));
      } else {
        left.push(chalk.hex(colors.textDim)(model));
      }
    }

    // Thinking level badge (show only when not 'off')
    if (state.thinkingLevel !== 'off') {
      left.push(chalk.hex(colors.primary).bold('[' + state.thinkingLevel + ']'));
    }

    // Background-task badges sit immediately before cwd. `bash-*` tasks
    // (shell processes) and `agent-*` tasks (background subagents) get
    // separate badges so the user can distinguish them at a glance.
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? '个任务' : '个任务';
      left.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundBashTaskCount)}${noun} 运行中]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? '个代理' : '个代理';
      left.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundAgentCount)}${noun} 运行中]`),
      );
    }

    const cwd = shortenCwd(state.workDir);
    if (cwd) left.push(chalk.hex(colors.status)(cwd));

    const git = this.gitCache.getStatus();
    if (git !== null) {
      left.push(formatFooterGitBadge(git, colors));
    }

    const leftLine = left.join('  ');
    const leftWidth = visibleWidth(leftLine);

    // ── Right side: transient hint (when active) or status info ─────
    // The cache segment is the first detail dropped when space is tight, so
    // adding it cannot hide context/activity on terminals that fitted before.
    let rightCandidates: readonly string[];
    if (this.transientHint) {
      rightCandidates = [chalk.hex(colors.warning).bold(this.transientHint)];
    } else {
      const statusLine = buildStatusLine(
        state.streamingPhase,
        state.livePaneMode,
        state.streamingStartTime,
      );
      const ccDot = state.ccConnectActive
        ? chalk.hex(colors.success)('●')
        : chalk.hex(colors.textDim)('●');
      const contextStatus = ccDot + ' ' + formatContextStatus(
        state.contextUsage,
        state.contextTokens,
        state.maxContextTokens,
      );
      const cacheStatus = formatPromptCacheStatus(state.promptCacheHitRatio);
      const baseStatus = chalk.hex(colors.textDim)(contextStatus + '  ' + statusLine);
      rightCandidates = cacheStatus === null
        ? [baseStatus]
        : [
            chalk.hex(colors.textDim)(contextStatus + '  ' + cacheStatus + '  ' + statusLine),
            baseStatus,
          ];
    }
    const gap = 3;
    const rightText = rightCandidates.find(
      (candidate) => leftWidth + gap + visibleWidth(candidate) <= width,
    );

    let line1: string;
    if (rightText !== undefined) {
      const rightWidth = visibleWidth(rightText);
      const pad = width - leftWidth - rightWidth;
      line1 = leftLine + ' '.repeat(pad) + rightText;
    } else if (leftWidth <= width) {
      line1 = leftLine;
    } else {
      line1 = truncateToWidth(leftLine, width, '…');
    }

    return [truncateToWidth(line1, width)];
  }
}
