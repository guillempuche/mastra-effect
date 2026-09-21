import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mastra-effect-adapter',
    isolate: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['docs/repos/**'],
    testTimeout: 30_000,
    // The published suite calls `vi.mock('@mastra/core/vector')` at module scope. Vitest only
    // hoists that in files it transforms, and node_modules is externalized by default — in the
    // Mastra monorepo the suite is a workspace source package, so in-tree adapters never need
    // this. Inlining it restores the mocks the suite's own test context depends on.
    server: {
      deps: {
        inline: ['@mastra/server-adapters-test-suite'],
      },
    },
  },
});
