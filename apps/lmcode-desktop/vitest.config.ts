import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs'

const appRoot = import.meta.dirname

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources, so the prompt and
  // profile sources they import (`.md` / `.yaml`) need the same loader the
  // packages use in their own vitest configs.
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src/renderer'),
    },
  },
  test: {
    name: 'lmcode-desktop',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    server: {
      deps: {
        // `out/vendor/pdfjs` is a native ES module whose fake worker resolves
        // `./pdf.worker.mjs` relative to the module URL. Keep it outside Vite's
        // transformer so it is imported natively, exactly as in the app runtime.
        external: [/[\\/]out[\\/]vendor[\\/]pdfjs[\\/]/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html'],
    },
  },
})
