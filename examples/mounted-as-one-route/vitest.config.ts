import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mounted-as-one-route',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
