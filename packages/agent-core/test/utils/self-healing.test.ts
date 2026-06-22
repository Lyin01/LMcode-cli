import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateJavaScript,
  validateTypeScript,
  validateHtmlScripts,
  validateFileSyntax,
  validateFileSyntaxWithScreenshots,
  resolveChromiumExecutable,
  RUNTIME_KEYFRAME_TIMES_MS,
} from '../../src/utils/self-healing';

describe('self-healing: syntax validation', () => {
  describe('validateJavaScript', () => {
    it('returns null for valid JS', () => {
      const result = validateJavaScript('const a = 1; console.log(a);', 'test.js');
      expect(result).toBeNull();
    });

    it('returns syntax error message for invalid JS', () => {
      const result = validateJavaScript('const a = ;', 'test.js');
      expect(result).toContain('JavaScript syntax error');
    });
  });

  describe('validateTypeScript', () => {
    it('returns null for valid TS', async () => {
      const result = await validateTypeScript('const a: number = 1;', 'test.ts');
      expect(result).toBeNull();
    });

    it('returns error for invalid TS when typescript parser is available', async () => {
      const result = await validateTypeScript('const a: = 1;', 'test.ts');
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('validateHtmlScripts', () => {
    it('returns null for valid HTML with valid script', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head><title>Test</title></head>
        <body>
          <script>
            const a = 1;
          </script>
        </body>
        </html>
      `;
      const result = await validateHtmlScripts(html, 'test.html');
      expect(result).toBeNull();
    });

    it('returns script error for invalid script block in HTML', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <script>
            const a = ;
          </script>
        </body>
        </html>
      `;
      const result = await validateHtmlScripts(html, 'test.html');
      expect(result).toContain('HTML Script block error');
    });

    it('ignores scripts with src attribute', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <script src="https://example.com/some.js"></script>
          <script>
            const a = 1;
          </script>
        </body>
        </html>
      `;
      const result = await validateHtmlScripts(html, 'test.html');
      expect(result).toBeNull();
    });
  });

  describe('validateFileSyntax', () => {
    it('correctly routes js files', async () => {
      const result = await validateFileSyntax('foo.js', 'const x = ;');
      expect(result).toContain('JavaScript syntax error');
    });

    it('correctly routes ts files', async () => {
      const result = await validateFileSyntax('foo.ts', 'const x = 1;');
      expect(result).toBeNull();
    });

    it('ignores unknown extensions', async () => {
      const result = await validateFileSyntax('foo.txt', 'some random text');
      expect(result).toBeNull();
    });
  });

  describe('validateFileSyntaxWithScreenshots', () => {
    it('returns structured result for js', async () => {
      const result = await validateFileSyntaxWithScreenshots('foo.js', 'const x = ;');
      expect(result.error).toContain('JavaScript syntax error');
      expect(result.screenshots).toBeUndefined();
    });

    it('returns structured result for valid html', async () => {
      const result = await validateFileSyntaxWithScreenshots('foo.html', '<html><body>Hello</body></html>');
      expect(result.error).toBeNull();
    });
  });

  describe('runtime keyframe schedule', () => {
    it('starts at 0 and is strictly ascending', () => {
      expect(RUNTIME_KEYFRAME_TIMES_MS[0]).toBe(0);
      for (let i = 1; i < RUNTIME_KEYFRAME_TIMES_MS.length; i++) {
        const prev = RUNTIME_KEYFRAME_TIMES_MS[i - 1]!;
        const cur = RUNTIME_KEYFRAME_TIMES_MS[i]!;
        expect(cur).toBeGreaterThan(prev);
      }
    });

    it('captures a terminal frame past the typical animation finish (>15s)', () => {
      // Guards against the original bug class: only sampling up to 15s misses
      // uncleared-buffer ghosts and never-ending particle fields at the end.
      const last = RUNTIME_KEYFRAME_TIMES_MS[RUNTIME_KEYFRAME_TIMES_MS.length - 1];
      expect(last).toBeGreaterThan(15000);
    });
  });

  describe('resolveChromiumExecutable', () => {
    it('returns a string or undefined without throwing', () => {
      const result = resolveChromiumExecutable();
      expect(result === undefined || typeof result === 'string').toBe(true);
    });

    it('points at a real file when a cached browser is found', () => {
      const result = resolveChromiumExecutable();
      if (typeof result === 'string') {
        expect(existsSync(result)).toBe(true);
      }
    });
  });
});
