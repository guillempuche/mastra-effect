// docs/repos/effect is a second source of truth: the code compiles against the npm package while a
// reader consults the subtree. src/effect-api-gate.ts catches API drift but not version drift, and a
// dependency bot can move the npm side without touching the subtree, which no bot can update.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vendored = require('../docs/repos/effect/packages/effect/package.json').version;
const installed = require('effect/package.json').version;

console.log(`vendored:  ${vendored}`);
console.log(`installed: ${installed}`);

if (vendored !== installed) {
  console.log(`::error::docs/repos/effect is at ${vendored} but effect resolves to ${installed}.`);
  console.log(
    `Run: git subtree pull --prefix docs/repos/effect https://github.com/Effect-TS/effect.git effect@${installed} --squash`,
  );
  process.exit(1);
}
