import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fetch-handler',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
