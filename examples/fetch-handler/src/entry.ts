/**
 * The shape Bun, Deno (`deno serve`) and Cloudflare Workers all accept as a module's default
 * export: an object with a `fetch` method. See the README for Next.js, which wants named exports.
 */
import { createFetchHandler } from './handler.ts';

const { fetch } = createFetchHandler();

export default { fetch };
