import { describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

import { getColorPalette } from '#/tui/theme/colors';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';
import { shimmerText } from '#/tui/utils/shimmer';

function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
}

// The host applies a theme switch by `Object.assign(colors, nextColors)` on
// the live palette object. Any cache or pre-bound styler keyed on the
// palette identity (or capturing a hex at creation time) keeps serving the
// old theme. These tests pin the read-at-call-time contract.
describe('theme switch — in-place palette mutation', () => {
  it('shimmerText uses the mutated palette on the very next call', () => {
    // Pin the sweep band over the middle of the string (t=400ms puts the
    // glow center on 'lmcode'[2]) so the high tier (palette.primary) is
    // exercised deterministically — unpinned, tiers depend on Date.now().
    vi.useFakeTimers();
    try {
      vi.setSystemTime(400);
      const colors = { ...getColorPalette('dark') };
      const darkPrimary = colors.primary;
      const light = getColorPalette('light');
      expect(light.primary).not.toBe(darkPrimary);

      Object.assign(colors, light);

      const out = shimmerText('lmcode', colors);
      expect(out).toContain(hexToSgr(light.primary));
      expect(out).not.toContain(hexToSgr(darkPrimary));
    } finally {
      vi.useRealTimers();
    }
  });

  it('createEditorTheme stylers track the live palette (autocomplete colors)', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const colors = { ...getColorPalette('dark') };
      const theme = createEditorTheme(colors);
      const darkMuted = colors.textMuted;

      Object.assign(colors, getColorPalette('light'));

      const out = theme.selectList.description('desc');
      expect(out).toContain(hexToSgr(colors.textMuted));
      expect(out).not.toContain(hexToSgr(darkMuted));
    } finally {
      chalk.level = previousLevel;
    }
  });
});
