/**
 * UsagePanelComponent — wraps pre-coloured `/usage` lines in a blue box
 * border with a left indent, mirroring the PlanBoxComponent layout so
 * the pattern stays consistent across command-triggered panels.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { SessionStats, SessionUsage, TokenUsage } from '@lmcode-cli/lmcode-sdk';
import chalk from 'chalk';

import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format';
import type { ColorPalette } from '#/tui/theme/colors';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const MIN_INTERIOR_WIDTH = 20;

type Colorize = (text: string) => string;

export interface ManagedUsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly resetHint?: string;
}

export interface ManagedUsageReport {
  readonly summary: ManagedUsageRow | null;
  readonly limits: readonly ManagedUsageRow[];
}

export interface UsageReportOptions {
  readonly colors: ColorPalette;
  readonly sessionUsage?: SessionUsage;
  readonly sessionUsageError?: string;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

export interface ManagedUsageReportLineOptions {
  readonly colors: ColorPalette;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageInputTotal(usage: TokenUsage): number {
  return (
    usageNumber(usage.inputOther) +
    usageNumber(usage.inputCacheRead) +
    usageNumber(usage.inputCacheCreation)
  );
}

function buildSessionUsageSection(
  usage: SessionUsage | undefined,
  error: string | undefined,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
): string[] {
  if (error !== undefined) return [errorStyle(`  ${error}`)];
  const byModel = (usage as { readonly byModel?: Record<string, TokenUsage> } | undefined)
    ?.byModel;
  const entries = Object.entries(byModel ?? {});
  if (entries.length === 0) return [muted('  尚无 token 用量记录。')];

  const lines: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  for (const [model, row] of entries) {
    const input = usageInputTotal(row);
    const output = usageNumber(row.output);
    totalInput += input;
    totalOutput += output;
    totalCacheRead += usageNumber(row.inputCacheRead);
    lines.push(
      `  ${muted(model)}  输入 ${value(formatTokenCount(input))}  输出 ${value(
        formatTokenCount(output),
      )}  总计 ${value(formatTokenCount(input + output))}`,
    );
  }
  if (entries.length > 1) {
    lines.push(
      `  ${muted('总计')}  输入 ${value(formatTokenCount(totalInput))}  输出 ${value(
        formatTokenCount(totalOutput),
      )}  总计 ${value(formatTokenCount(totalInput + totalOutput))}`,
    );
  }
  // Prompt-cache efficiency: how much of the input was served from the
  // provider's prefix cache (DeepSeek cache hits cost ~98% less than misses).
  if (totalInput > 0) {
    const hitPct = ((totalCacheRead / totalInput) * 100).toFixed(1);
    lines.push(
      `  ${muted('缓存命中')}  ${value(`${hitPct}%`)}  ${muted(
        `(${formatTokenCount(totalCacheRead)} / ${formatTokenCount(totalInput)} 输入)`,
      )}`,
    );
  }
  return lines;
}

function buildManagedUsageSection(
  usage: ManagedUsageReport | undefined,
  error: string | undefined,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
  severityHex: (sev: 'ok' | 'warn' | 'danger') => string,
): string[] {
  if (error !== undefined) return [accent('计划用量'), errorStyle(`  ${error}`)];
  if (usage === undefined) return [];
  const { summary, limits } = usage;
  if (summary === null && limits.length === 0) {
    return [accent('计划用量'), muted('  暂无用量数据。')];
  }

  const rows: ManagedUsageRow[] = [];
  if (summary !== null) rows.push(summary);
  rows.push(...limits);
  const usedRatio = (r: ManagedUsageRow): number =>
    r.limit > 0 ? Math.max(0, Math.min(r.used / r.limit, 1)) : 0;
  const labelWidth = Math.max(10, ...rows.map((r) => r.label.length));
  const pctWidth = Math.max(...rows.map((r) => `${Math.round(usedRatio(r) * 100)}% used`.length));
  const out: string[] = [accent('计划用量')];
  for (const row of rows) {
    const ratioUsed = usedRatio(row);
    const bar = renderProgressBar(ratioUsed, 20);
    const pct = `${Math.round(ratioUsed * 100)}% 已用`;
    const barColoured = chalk.hex(severityHex(ratioSeverity(ratioUsed)))(bar);
    const label = row.label.padEnd(labelWidth, ' ');
    const resetStr = row.resetHint ? `  ${muted(row.resetHint)}` : '';
    out.push(`  ${muted(label)}  ${barColoured}  ${value(pct.padEnd(pctWidth, ' '))}${resetStr}`);
  }
  return out;
}

export function buildManagedUsageReportLines(options: ManagedUsageReportLineOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  return buildManagedUsageSection(
    options.managedUsage,
    options.managedUsageError,
    accent,
    value,
    muted,
    errorStyle,
    severityHex,
  );
}

export function buildUsageReportLines(options: UsageReportOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  const lines: string[] = [
    accent('会话用量'),
    ...buildSessionUsageSection(
      options.sessionUsage,
      options.sessionUsageError,
      value,
      muted,
      errorStyle,
    ),
  ];

  if (options.maxContextTokens > 0) {
    const ratio = safeUsageRatio(options.contextUsage);
    const bar = renderProgressBar(ratio, 20);
    const pct = `${(ratio * 100).toFixed(1)}%`;
    const barColoured = chalk.hex(severityHex(ratioSeverity(ratio)))(bar);
    lines.push('');
    lines.push(accent('上下文窗口'));
    lines.push(
      `  ${barColoured}  ${value(pct.padStart(6, ' '))}  ` +
        muted(
          `(${formatTokenCount(options.contextTokens)} / ${formatTokenCount(
            options.maxContextTokens,
          )})`,
        ),
    );
  }

  const managedSection = buildManagedUsageReportLines({
    colors,
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  return lines;
}

export interface StatsReportOptions {
  readonly colors: ColorPalette;
  readonly stats?: SessionStats;
  readonly statsError?: string;
}

function formatUsd(value: number): string {
  // Sub-cent costs are common for short sessions; show enough precision to be
  // useful without drowning in digits.
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function buildStatsReportLines(options: StatsReportOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);

  if (options.statsError !== undefined) {
    return [accent('会话统计'), errorStyle(`  ${options.statsError}`)];
  }
  const stats = options.stats;
  if (stats === undefined) {
    return [accent('会话统计'), muted('  暂无统计数据。')];
  }

  const lines: string[] = [accent('会话统计')];

  // Tokens
  lines.push(
    `  ${muted('输入')} ${value(formatTokenCount(stats.inputTokens))}  ${muted('输出')} ${value(
      formatTokenCount(stats.outputTokens),
    )}  ${muted('总计')} ${value(formatTokenCount(stats.totalTokens))}`,
  );
  if (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) {
    lines.push(
      `  ${muted('缓存读取')} ${value(formatTokenCount(stats.cacheReadTokens))}  ${muted(
        '缓存写入',
      )} ${value(formatTokenCount(stats.cacheWriteTokens))}`,
    );
  }

  // Cost
  if (stats.estimatedCostUsd !== undefined) {
    lines.push(`  ${muted('预估费用')} ${value(formatUsd(stats.estimatedCostUsd))}`);
    const costByModel = stats.costByModel;
    if (costByModel !== undefined && Object.keys(costByModel).length > 1) {
      for (const [model, cost] of Object.entries(costByModel)) {
        lines.push(`    ${muted(model)}  ${value(formatUsd(cost))}`);
      }
    }
  } else {
    lines.push(`  ${muted('预估费用')} ${muted('未配置定价')}`);
  }

  // Activity
  lines.push('');
  lines.push(accent('活动'));
  lines.push(
    `  ${muted('LLM 步数')} ${value(String(stats.llmSteps))}  ${muted('工具调用')} ${value(
      String(stats.toolCalls),
    )}`,
  );
  lines.push(
    `  ${muted('重试')} ${value(String(stats.retries))}  ${muted('压缩')} ${value(
      String(stats.compactions),
    )}`,
  );
  const toolCallsByName = stats.toolCallsByName;
  if (toolCallsByName !== undefined && Object.keys(toolCallsByName).length > 0) {
    const sorted = Object.entries(toolCallsByName).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      lines.push(`    ${muted(name)}  ${value(String(count))}`);
    }
  }

  return lines;
}

export class UsagePanelComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly lines: readonly string[],
    private readonly borderHex: string,
    private readonly title: string = ' 用量 ',
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const availableInterior = Math.max(
      MIN_INTERIOR_WIDTH,
      width - LEFT_MARGIN - 2 - 2 * SIDE_PADDING,
    );
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(
      MIN_INTERIOR_WIDTH,
      Math.min(availableInterior, longestLine, Math.max(longestLine, this.title.length)),
    );
    const horzLen = contentWidth + 2 * SIDE_PADDING;

    const trailingDashLen = Math.max(0, horzLen - visibleWidth(this.title));
    const top =
      indent + paint('╭') + paint(this.title) + paint('─'.repeat(trailingDashLen)) + paint('╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }
}
