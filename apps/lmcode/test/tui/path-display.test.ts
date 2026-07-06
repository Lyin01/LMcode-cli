import { describe, expect, it } from 'vitest';

import { aliasHome } from '#/tui/utils/path-display';

// `home` is injected so these assertions are identical on Windows and POSIX
// CI — the whole point of the fix is that separators and the home source no
// longer depend on the running platform.
describe('aliasHome', () => {
  describe('POSIX-style paths', () => {
    it('aliases an exact home match to ~', () => {
      expect(aliasHome('/home/alice', '/home/alice')).toBe('~');
    });

    it('aliases a path under home to ~/…', () => {
      expect(aliasHome('/home/alice/projects/app', '/home/alice')).toBe('~/projects/app');
    });

    it('only matches on a segment boundary (not a mere prefix)', () => {
      // /home/alice2 must not be aliased against home /home/alice.
      expect(aliasHome('/home/alice2/app', '/home/alice')).toBe('/home/alice2/app');
    });

    it('returns the path unchanged when it is outside home', () => {
      expect(aliasHome('/var/log/app', '/home/alice')).toBe('/var/log/app');
    });
  });

  describe('Windows-style paths', () => {
    it('aliases an exact home match despite backslashes', () => {
      expect(aliasHome('C:\\Users\\alice', 'C:\\Users\\alice')).toBe('~');
    });

    it('aliases a backslash path under home and renders it forward-slash', () => {
      expect(aliasHome('C:\\Users\\alice\\projects\\app', 'C:\\Users\\alice')).toBe(
        '~/projects/app',
      );
    });

    it('normalizes an outside path to forward slashes for display', () => {
      expect(aliasHome('E:\\project for cc\\lmcode', 'C:\\Users\\alice')).toBe(
        'E:/project for cc/lmcode',
      );
    });

    it('respects the segment boundary on Windows too', () => {
      expect(aliasHome('C:\\Users\\alice2\\app', 'C:\\Users\\alice')).toBe('C:/Users/alice2/app');
    });
  });

  describe('edge cases', () => {
    it('returns an empty string unchanged', () => {
      expect(aliasHome('', '/home/alice')).toBe('');
    });

    it('returns the normalized path when home is empty', () => {
      expect(aliasHome('C:\\Users\\alice', '')).toBe('C:/Users/alice');
    });
  });
});
