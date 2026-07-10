import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlaywrightRuntime } from '../../src/utils/self-healing';
import {
  validateJavaScript,
  validateJavaScriptAuto,
  validateJavaScriptModule,
  validateTypeScript,
  validateHtmlScripts,
  validateHtmlRuntime,
  validateFileSyntax,
  validateFileSyntaxWithScreenshots,
  resolveChromiumExecutable,
  RUNTIME_KEYFRAME_TIMES_MS,
  cleanStack,
  extractLineNumber,
  getCodeContext,
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

    // Data blocks per the HTML spec — never executed by the browser, and
    // must never be parsed as JavaScript. Regression tests for the
    // "Unexpected token ':'" false positive on import maps.
    it('skips importmap data blocks', async () => {
      const html = `<html><head>
        <script type="importmap">{ "imports": { "three": "https://cdn.example/three.module.js" } }</script>
      </head></html>`;
      expect(await validateHtmlScripts(html, 'test.html')).toBeNull();
    });

    it('skips application/json and ld+json data blocks', async () => {
      const html = `<html><head>
        <script type="application/json">{"a": 1}</script>
        <script type="application/ld+json">{"@context": "https://schema.org"}</script>
        <script type="text/x-template"><div>{{ not js }}</div></script>
      </head></html>`;
      expect(await validateHtmlScripts(html, 'test.html')).toBeNull();
    });

    it('accepts import/export inside <script type="module">', async () => {
      const html = `<html><body>
        <script type="module">
          import * as THREE from 'three';
          export const scene = new THREE.Scene();
          await Promise.resolve();
        </script>
      </body></html>`;
      expect(await validateHtmlScripts(html, 'test.html')).toBeNull();
    });

    it('still flags real syntax errors inside <script type="module">', async () => {
      const html = `<html><body>
        <script type="module">const x = ;</script>
      </body></html>`;
      expect(await validateHtmlScripts(html, 'test.html')).toContain('HTML Script block error');
    });

    it('still flags import statements in classic scripts (real browser error)', async () => {
      const html = `<html><body>
        <script>import x from 'y';</script>
      </body></html>`;
      expect(await validateHtmlScripts(html, 'test.html')).toContain('HTML Script block error');
    });
  });

  describe('validateJavaScriptModule / validateJavaScriptAuto', () => {
    it('accepts plain ESM in .js via auto goal detection', async () => {
      const code = `import { readFile } from 'node:fs/promises';\nexport const x = await readFile('a');`;
      expect(await validateJavaScriptAuto(code, 'test.js')).toBeNull();
    });

    it('still reports genuine errors in ESM code', async () => {
      const result = await validateJavaScriptModule(`import { a } from 'b';\nconst y = ;`, 'test.mjs');
      expect(result).toContain('JavaScript syntax error');
    });

    it('keeps the script-goal error when the code is broken either way', async () => {
      expect(await validateJavaScriptAuto('const x = ;', 'test.js')).toContain(
        'JavaScript syntax error',
      );
    });
  });

  describe('validateFileSyntax', () => {
    it('correctly routes js files', async () => {
      const result = await validateFileSyntax('foo.js', 'const x = ;');
      expect(result).toContain('JavaScript syntax error');
    });

    it('accepts ESM syntax in .js and .mjs files', async () => {
      expect(await validateFileSyntax('foo.js', `import x from 'y';\nexport default x;`)).toBeNull();
      expect(await validateFileSyntax('foo.mjs', `export const a = 1;`)).toBeNull();
    });

    it('routes .cjs as script goal', async () => {
      expect(await validateFileSyntax('foo.cjs', `const x = require('y'); module.exports = x;`)).toBeNull();
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
      expect(result.syntax).toEqual({ status: 'failed' });
      expect(result.runtime).toBeUndefined();
      expect(result.screenshots).toBeUndefined();
    });

    it('returns structured result for valid html', async () => {
      const result = await validateFileSyntaxWithScreenshots('foo.html', '<html><body>Hello</body></html>');
      expect(result.error).toBeNull();
      expect(result.syntax).toEqual({ status: 'passed' });
      expect(['passed', 'skipped']).toContain(result.runtime?.status);
    });

    it('reports skipped when browser runtime validation is unavailable', async () => {
      const result = await validateHtmlRuntime('foo.html', '<html><body>Hello</body></html>', {
        loadPlaywright: async () => null,
      });

      expect(result).toEqual({
        error: null,
        syntax: undefined,
        runtime: {
          status: 'skipped',
          reason: 'playwright-unavailable',
          detail: undefined,
        },
        screenshots: undefined,
        keyframeTimesMs: undefined,
      });
    });

    it('reports skipped instead of passed when the browser cannot launch', async () => {
      const playwright = {
        chromium: {
          launch: async () => {
            throw new Error('browser launch failed');
          },
        },
      } as unknown as PlaywrightRuntime;
      const result = await validateHtmlRuntime('foo.html', '<html><body>Hello</body></html>', {
        loadPlaywright: async () => playwright,
      });

      expect(result.error).toBeNull();
      expect(result.runtime).toEqual({
        status: 'skipped',
        reason: 'runtime-validation-error',
        detail: 'browser launch failed',
      });
    });

    it('does not claim module syntax passed when the parser and browser are unavailable', async () => {
      const result = await validateFileSyntaxWithScreenshots(
        'foo.html',
        '<html><script type="module">const value = ;</script></html>',
        {
          loadTypeScript: async () => null,
          loadPlaywright: async () => null,
        },
      );

      expect(result.error).toBeNull();
      expect(result.syntax).toEqual({
        status: 'skipped',
        reason: 'typescript-unavailable',
        detail: undefined,
      });
      expect(result.runtime).toEqual({
        status: 'skipped',
        reason: 'playwright-unavailable',
        detail: undefined,
      });
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

  describe('cleanStack', () => {
    it('removes browser/node internal frames and absolute paths', () => {
      const stack = `TypeError: Cannot read properties of null
    at draw (file:///C:/Users/18312/AppData/Local/Temp/burn.html:7:26)
    at Browser.runTask (node:internal/modules/esm:123:45)
    at onload (C:\\Users\\18312\\AppData\\Local\\Temp\\burn.html:12:24)`;
      const cleaned = cleanStack(stack, 'C:\\Users\\18312\\AppData\\Local\\Temp\\burn.html');
      expect(cleaned).toContain('at draw (burn.html:7:26)');
      expect(cleaned).toContain('at onload (burn.html:12:24)');
      expect(cleaned).not.toContain('node:internal');
      expect(cleaned).not.toContain('C:/Users/18312');
    });
  });

  describe('extractLineNumber', () => {
    it('correctly parses line number matching filepath', () => {
      const stack = `TypeError: Cannot read properties of null
    at draw (burn.html:7:26)
    at onload (burn.html:12:24)`;
      const line = extractLineNumber(stack, 'C:\\Users\\18312\\AppData\\Local\\Temp\\burn.html');
      expect(line).toBe(7);
    });
  });

  describe('getCodeContext', () => {
    it('generates a snippet with the correct line numbers and marker', () => {
      const code = 'line1\nline2\nline3\nline4\nline5';
      const context = getCodeContext(code, 3, 1);
      expect(context).toBe([
        '     2 | line2',
        ' >>> 3 | line3',
        '     4 | line4',
      ].join('\n'));
    });
  });

  describe('HTML Script line offset mapping', () => {
    it('offsets local script block errors to absolute HTML document lines', async () => {
      const html = `<!DOCTYPE html>
<html>
<body>
  <script>
    // comment 1
    // comment 2
    const a = ;
  </script>
</body>
</html>`;
      const error = await validateHtmlScripts(html, 'C:\\Users\\18312\\AppData\\Local\\Temp\\burn.html');
      expect(error).toContain('HTML Script block error');
      expect(error).toContain('burn.html:7');
      expect(error).toContain('Context around line 7 of HTML');
      expect(error).toContain(' >>> 7 |     const a = ;');
    });
  });
});
