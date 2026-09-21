import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  fixedExtension: false,
  nodeProtocol: 'strip',
  clean: true,
  dts: true,
  treeshake: true,
  sourcemap: true,

  // A dual ESM/CJS package with separate .d.ts and .d.cts is exactly the shape
  // that breaks quietly for consumers. publint checks the manifest and exports
  // map; attw checks that the types actually resolve the way a consumer's
  // TypeScript will read them. Both fail the build rather than warn, because a
  // warning at publish time is a warning nobody reads.
  publint: true,
  attw: { profile: 'node16' },
});
