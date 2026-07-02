import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;
const repoRoot = resolve(appRoot, '../..');

export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  plugins: [rawTextPlugin()],
  // fastembed pulls in onnxruntime-node and platform-specific native
  // tokenizer packages that cannot be bundled. It ships as an
  // optionalDependency instead; the memory package degrades to
  // tag-only retrieval when the runtime import fails.
  external: ['fastembed'],
  alias: {
    '@': resolve(appRoot, 'src'),
    '@lmcode/memory': resolve(repoRoot, 'packages/memory/src/index.ts'),
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },

});
