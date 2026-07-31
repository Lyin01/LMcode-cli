/**
 * tsx / Node loader hook that resolves workspace-internal `#/...` imports and
 * lets `.md` and `.yaml` files be imported as raw default-exported strings —
 * mirroring the package import aliases and `build/raw-text-plugin.mjs` used by
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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const WORKSPACE_INTERNAL_PREFIX = '#/';
const packageSourceRoots = new Map();

function findPackageSourceRoot(parentURL) {
  if (typeof parentURL !== 'string' || !parentURL.startsWith('file:')) return undefined;
  const parentPath = fileURLToPath(parentURL);
  if (packageSourceRoots.has(parentPath)) return packageSourceRoots.get(parentPath);

  let directory = dirname(parentPath);
  while (true) {
    const sourceRoot = resolvePath(directory, 'src');
    if (existsSync(resolvePath(directory, 'package.json')) && existsSync(sourceRoot)) {
      packageSourceRoots.set(parentPath, sourceRoot);
      return sourceRoot;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  packageSourceRoots.set(parentPath, undefined);
  return undefined;
}

function resolveWorkspaceInternalImport(specifier, parentURL) {
  if (typeof specifier !== 'string' || !specifier.startsWith(WORKSPACE_INTERNAL_PREFIX)) {
    return undefined;
  }
  const subpath = specifier.slice(WORKSPACE_INTERNAL_PREFIX.length);
  if (
    subpath.length === 0
    || subpath.includes('\\')
    || subpath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }

  const sourceRoot = findPackageSourceRoot(parentURL);
  if (sourceRoot === undefined) return undefined;
  const basePath = resolvePath(sourceRoot, subpath);
  const candidates = [basePath, `${basePath}.ts`, `${basePath}.mts`, `${basePath}.cts`];
  candidates.push(
    resolvePath(basePath, 'index.ts'),
    resolvePath(basePath, 'index.mts'),
    resolvePath(basePath, 'index.cts'),
  );
  const resolved = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return resolved === undefined ? undefined : pathToFileURL(resolved).href;
}

function isRaw(urlOrPath) {
  const path = urlOrPath.split('?', 1)[0] ?? urlOrPath;
  return RAW_EXTENSIONS.some((ext) => path.endsWith(ext));
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const internalURL = resolveWorkspaceInternalImport(specifier, context.parentURL);
    if (internalURL === undefined) return nextResolve(specifier, context);
    return { shortCircuit: true, url: internalURL };
  },
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
