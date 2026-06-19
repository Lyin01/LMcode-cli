import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Standalone vitest config for the eval harness. `evals/` is intentionally
 * outside the root workspace `projects` globs (`packages/*`, `apps/lmcode`) so
 * it stays off the build/publish graph, which means its tests need their own
 * config. Run with:  pnpm exec vitest run --config evals/vitest.config.ts
 *
 * `root` is pinned to this directory so the `include` glob only ever matches
 * eval tests, never the rest of the monorepo.
 */
const evalsDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: evalsDir,
  test: {
    name: 'evals',
    include: ['**/*.test.ts'],
  },
});
