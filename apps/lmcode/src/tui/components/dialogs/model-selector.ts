import type { ModelAlias } from '@lmcode-cli/lmcode-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import type { ColorPalette } from '#/tui/theme/colors';
import { SearchableList } from '#/tui/utils/searchable-list';
import { SELECT_POINTER } from '../../constant/symbols';

import type { ChoiceOption } from './choice-picker';
import type { ThinkingLevel } from '#/tui/types';
import { THINKING_LEVELS } from '#/tui/types';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  readonly label: string;
}

export interface ModelSelection {
  readonly alias: string;
  readonly thinkingLevel: ThinkingLevel;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  return model?.displayName ?? model?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    value: alias,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingLevel: ThinkingLevel;
  readonly colors: ColorPalette;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate (PgUp/PgDn). */
  readonly pageSize?: number;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    alias,
    model: cfg,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
}

function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  // Forcing adaptive thinking implies the model supports thinking, even when the
  // alias declares no capabilities — e.g. a custom-named endpoint configured with
  // only `adaptive_thinking = true`. Without this it would render as "unsupported"
  // and switching to it would force thinking off.
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

function effectiveThinkingLevel(model: ModelAlias, draft: ThinkingLevel): ThinkingLevel {
  const availability = thinkingAvailability(model);
  if (availability === 'always-on') return draft === 'off' ? 'high' : draft;
  if (availability === 'unsupported') return 'off';
  return draft;
}

export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  private thinkingDraft: ThinkingLevel;

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (c) => c.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
    this.thinkingDraft = opts.currentThinkingLevel;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    const selected = this.list.selected();
    // Left/Right cycle thinking levels (only when the model supports it); paging
    // is on PgUp/PgDn so the horizontal arrows stay free for the thinking control.
    if (selected !== undefined && thinkingAvailability(selected.model) === 'toggle') {
      if (matchesKey(data, Key.left)) {
        const idx = THINKING_LEVELS.indexOf(this.thinkingDraft);
        this.thinkingDraft = THINKING_LEVELS[Math.max(idx - 1, 0)] ?? 'off';
        return;
      }
      if (matchesKey(data, Key.right)) {
        const idx = THINKING_LEVELS.indexOf(this.thinkingDraft);
        this.thinkingDraft = THINKING_LEVELS[Math.min(idx + 1, THINKING_LEVELS.length - 1)] ?? 'max';
        return;
      }
    }
    if (matchesKey(data, Key.enter)) {
      if (selected === undefined) return;
      this.opts.onSelect({
        alias: selected.alias,
        thinkingLevel: effectiveThinkingLevel(selected.model, this.thinkingDraft),
      });
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const choices = view.items;

    const navParts = ['↑↓ 模型', '←→ 思考'];
    if (view.page.pageCount > 1) navParts.push('PgUp/PgDn 翻页');
    navParts.push('Enter 应用', 'Esc 取消');

    const titleSuffix =
      searchable && view.query.length === 0 ? chalk.hex(colors.textMuted)('  (输入搜索)') : '';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' 选择模型') + titleSuffix,
    ];
    if (searchable && view.query.length > 0) {
      lines.push(chalk.hex(colors.primary)(' 搜索：') + chalk.hex(colors.text)(view.query));
    }
    lines.push(chalk.hex(colors.textMuted)(` ${navParts.join(' · ')}`));
    lines.push('');

    if (choices.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('   No matches'));
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const choice = choices[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = choice.alias === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const labelStyle = isSelected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
      let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(`  ${pointer} `);
      line += labelStyle(choice.label);
      if (isCurrent) {
        line += ' ' + chalk.hex(colors.success)('← current');
      }
      lines.push(line);
    }

    lines.push('');
    lines.push(chalk.hex(colors.textMuted)(' Thinking'));
    const selected = choices[view.selectedIndex];
    if (selected !== undefined) {
      lines.push(this.renderThinkingControl(selected.model));
    }
    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(
        chalk.hex(colors.textMuted)(
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderThinkingControl(model: ModelAlias): string {
    const { colors } = this.opts;
    const segment = (label: string, active: boolean): string =>
      active
        ? chalk.hex(colors.primary).bold(`[ ${label} ]`)
        : chalk.hex(colors.text)(`  ${label}  `);

    const availability = thinkingAvailability(model);
    if (availability === 'always-on') {
      // Show all levels except 'off' (clamp draft to 'high' if it's 'off')
      const effective = this.thinkingDraft === 'off' ? 'high' : this.thinkingDraft;
      const levels = THINKING_LEVELS.filter((l) => l !== 'off');
      return '  ' + levels.map((l) => segment(l, l === effective)).join('') + '  ←/→';
    }
    if (availability === 'unsupported') {
      return `  ${segment('off', true)} ${chalk.hex(colors.textMuted)('unsupported')}`;
    }
    return (
      '  ' +
      THINKING_LEVELS.map((l) => segment(l, l === this.thinkingDraft)).join('') +
      '  ←/→'
    );
  }
}
