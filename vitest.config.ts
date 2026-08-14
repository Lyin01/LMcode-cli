import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // Windows process, Git and browser integration tests contend heavily when
    // Vitest maps every logical CPU to a worker. Cap the workspace pool so
    // timing contracts measure the code instead of host resource starvation.
    maxWorkers: process.platform === 'win32' ? 4 : undefined,
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
