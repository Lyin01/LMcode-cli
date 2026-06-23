import { readFileSync } from 'node:fs';

/**
 * Bundler plugin that lets `.md` / `.yaml` files be imported as raw strings:
 *
 *   import description from './grep.md';
 *
 * The file content is inlined into the bundle at build time, so prompt
 * source files never ship separately in `dist`. Shared by tsdown (build)
 * and vitest (test) so both resolve these imports identically.
 */
export function rawTextPlugin() {
  return {
    name: 'raw-text',
    enforce: 'pre',
    load(id) {
      const path = id.split('?', 1)[0] ?? id;
      if (!path.endsWith('.md') && !path.endsWith('.yaml')) return null;
      // Normalize line endings so the inlined string (and anything derived from
      // it, like prompt token counts) is identical on every platform. Without
      // this, a CRLF working tree on Windows yields different content than an LF
      // checkout, making token-count snapshots diverge across OSes.
      const text = readFileSync(path, 'utf-8').replace(/\r\n?/g, '\n');
      return { code: `export default ${JSON.stringify(text)};`, map: null };
    },
  };
}
