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
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html'],
    },
  },
})
