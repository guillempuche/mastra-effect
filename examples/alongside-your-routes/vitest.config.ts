import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'alongside-your-routes',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
