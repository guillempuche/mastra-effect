/**
 * Use case: you are not running an Effect server — you have a platform or framework that calls a
 * function with a `Request` and expects a `Response` back (Bun, Deno, Cloudflare Workers, a
 * Next.js route handler).
 *
 * The adapter still builds an Effect router of Mastra's routes; `toWebHandler` turns that router
 * into exactly such a function. Effect runs inside it, and nothing outside needs to know.
 */
import { createMastraServer, toWebHandler } from '@guillem_puche/mastra-effect';
import type { Mastra } from '@mastra/core';

import { createMastra } from './mastra.ts';

export interface FetchHandler {
  /** Answers one request. Safe to call before Mastra has finished starting: it waits. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Releases what the handler holds. The next `fetch` after this starts Mastra again. */
  readonly dispose: () => Promise<void>;
}

type WebHandler = ReturnType<typeof toWebHandler>;

/**
 * Mastra is started on the first request rather than when this file is imported. Importing stays
 * cheap, and a tool that only imports the file — a bundler, a type check, a build step — never
 * starts Mastra at all.
 */
export function createFetchHandler(makeMastra: () => Mastra = createMastra): FetchHandler {
  let ready: Promise<WebHandler> | undefined;

  const start = (): Promise<WebHandler> => {
    // Concurrent first requests share one start instead of each starting Mastra.
    if (ready) return ready;

    // Inside a promise, so a factory that throws fails the same way as one whose Mastra fails to
    // start — both become a rejected start the next request can retry.
    const attempt = Promise.resolve()
      .then(() => createMastraServer({ mastra: makeMastra() }))
      .then(({ router }) => toWebHandler(router));
    ready = attempt;

    attempt.catch(() => {
      // Forget the failure, so the next request tries again instead of failing forever. Only if it
      // is still the current start: after a dispose, a newer start may have replaced it, and
      // clearing that one would orphan a running Mastra that nothing ever disposes.
      if (ready === attempt) ready = undefined;
    });
    return attempt;
  };

  return {
    // Only the request is passed on. Frameworks call handlers with extra arguments — Next.js
    // passes the route's params — and while Effect ignores anything that is not its own context,
    // a one-argument function keeps the framework's type check happy too.
    fetch: async request => (await start()).handler(request),
    dispose: async () => {
      const current = ready;
      ready = undefined;
      // A start that failed holds nothing to release, so its error is not the caller's problem here.
      const handler = await current?.catch(() => undefined);
      await handler?.dispose();
    },
  };
}
