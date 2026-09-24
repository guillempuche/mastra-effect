import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { registerApiRoute } from '@mastra/core/server';
import { InMemoryStore } from '@mastra/core/storage';

const assistant = new Agent({
  id: 'assistant',
  name: 'assistant',
  instructions: 'You are a terse assistant.',
  // Generating text needs a provider key. Nothing in this example calls the model, so none is set.
  model: 'openai/gpt-4o',
});

/**
 * A Mastra custom API route: a route you define in Mastra's config rather than in the app.
 *
 * Mastra refuses any custom route under its own prefix (`/api`), so these always live somewhere
 * else — here `/hooks`. That matters once you compare this example with ../mounted-as-one-route.
 */
const echoHook = registerApiRoute('/hooks/echo', {
  method: 'POST',
  handler: async c => {
    // A body that is not JSON is the caller's mistake: answer 400, not the 500 an uncaught parse
    // error would become.
    const body: unknown = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json({ error: 'Expected a JSON body' }, 400);
    return c.json({ received: body });
  },
});

export function createMastra(): Mastra {
  return new Mastra({
    storage: new InMemoryStore(),
    agents: { assistant },
    server: {
      apiRoutes: [echoHook],
      build: {
        // Mastra's request log. Because Mastra's routes and yours share one router, it records
        // requests to your routes too — `excludePaths` is how you keep them out. Paths are compared
        // exactly, case included, while the router ignores case: `/HEALTHZ` is served and logged.
        apiReqLogs: { enabled: true, excludePaths: ['/healthz'] },
      },
    },
  });
}
