import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mastra-in-an-effect-server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
