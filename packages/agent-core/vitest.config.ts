import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'lmcode-core',
    include: ['test/**/*.{test,e2e}.ts'],
    testTimeout: 15_000,
    deps: {
      optimizer: {
        ssr: {
          include: ['linkedom', 'nunjucks', 'ajv', 'ajv-formats', '@mozilla/readability'],
        },
      },
    },
  },
});
