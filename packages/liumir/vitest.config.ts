import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'liumir',
    include: ['test/**/*.test.ts'],
  },
});
