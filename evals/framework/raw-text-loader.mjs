/**
 * tsx / Node loader hook that lets `.md` and `.yaml` files be imported as raw
 * default-exported strings — mirroring `build/raw-text-plugin.mjs` used by
 * tsdown (build) and vitest (test).
 *
 * The workspace packages resolve `@lmcode-cli/*` to their TypeScript `src/`
 * during dev, and that source imports prompt text like `import desc from
 * './grep.md'`. tsx can't handle those natively, so we register this loader via
 * `--import` (see the `eval` script in the root package.json) to keep
 * source-mode resolution identical to the build/test pipelines.
 *
 * Uses the *synchronous* `module.registerHooks` API (Node >= 22.15 / 23.5+):
 * the prompt `.md` files are imported through the synchronous CJS-interop load
 * path that async ESM hooks don't intercept, so sync hooks are required.
 */

import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// One agent-core source file (`utils/render-prompt.ts`) lazily calls bare
// `require('nunjucks')`. Under the build/test pipelines a bundler supplies the
// CJS interop; running source directly through tsx (ESM) leaves `require`
// undefined. Install a global `require` rooted in the agent-core package so that
// single call resolves its CJS dep. Harmless for all other modules.
if (typeof globalThis.require === 'undefined') {
  const here = dirname(fileURLToPath(import.meta.url));
  const agentCoreSrc = resolvePath(here, '../../packages/agent-core/src/index.ts');
  globalThis.require = createRequire(agentCoreSrc);
}

const RAW_EXTENSIONS = ['.md', '.yaml', '.yml'];

function isRaw(urlOrPath) {
  const path = urlOrPath.split('?', 1)[0] ?? urlOrPath;
  return RAW_EXTENSIONS.some((ext) => path.endsWith(ext));
}

registerHooks({
  load(url, context, nextLoad) {
    if (!isRaw(url)) return nextLoad(url, context);
    const filePath = fileURLToPath(url.split('?', 1)[0] ?? url);
    const text = readFileSync(filePath, 'utf-8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  },
});
