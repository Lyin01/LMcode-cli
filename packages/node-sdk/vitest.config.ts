import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@lmcode-cli/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
      '@lmcode-cli/config': fileURLToPath(
        new URL('../config/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'lmcode-sdk',
    include: ['test/**/*.test.ts'],
    // These tests spin up a real subprocess transport; cold process spawn on a
    // loaded CI runner (notably Windows) can exceed vitest's 5s default and flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
