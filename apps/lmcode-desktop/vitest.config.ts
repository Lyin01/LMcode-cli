import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const appRoot = import.meta.dirname

export default defineConfig({
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
