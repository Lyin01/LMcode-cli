import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
    },
    deps: {
      optimizer: {
        ssr: {
          include: ['linkedom', 'nunjucks', 'ajv', 'ajv-formats', '@mozilla/readability'],
        },
      },
    },
  },
});
