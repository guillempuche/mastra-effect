import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mastra-effect-adapter',
    isolate: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['docs/repos/**'],
    testTimeout: 30_000,
  },
});
