import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'lmcode-oauth',
    include: ['test/**/*.test.ts'],
  },
});
