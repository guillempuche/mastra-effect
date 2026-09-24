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
 * A Mastra custom API route. Mastra refuses any custom route under its own prefix (`/api`), so it
 * cannot ride along with the `/api/*` forward — server.ts forwards `/hooks/*` separately.
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
        // Mastra's request log. Mastra has a router of its own here, so the log only ever sees
        // requests that were forwarded to Mastra — no `excludePaths` needed for the app's routes.
        apiReqLogs: true,
      },
    },
  });
}
