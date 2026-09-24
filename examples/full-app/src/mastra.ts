import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { MastraAuthBetterAuth } from '@mastra/auth-better-auth';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import type { Auth } from './auth.ts';
import { mastraObservability, telemetryEnabled } from './observability.ts';

const echo = createTool({
  id: 'echo',
  description: 'Returns whatever it is given. Stands in for a real tool.',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ message }) => ({ message }),
});

/**
 * MCP is served by Mastra rather than by Effect's own `McpServer`.
 *
 * They answer different questions: this exposes *Mastra's* agents and tools to MCP clients, which
 * is the reason to run Mastra at all. Effect's `McpServer.layerHttp` exposes the *app's* domain and
 * can mount on the same router alongside this, on a different path.
 */
const mcpServer = new MCPServer({
  name: 'example-mcp',
  version: '0.0.0',
  tools: { echo },
});

const assistant = new Agent({
  id: 'assistant',
  name: 'assistant',
  instructions: 'You are a terse assistant.',
  // Generating needs a provider key; the tests here never call it. Swap for whatever you use.
  model: 'openai/gpt-4o',
  tools: { echo },
});

export function createMastra(auth: Auth): Mastra {
  return new Mastra({
    // Agent, model and tool spans, in the same trace as the HTTP request — when telemetry is on.
    ...(telemetryEnabled() ? { observability: mastraObservability('example-full-app') } : {}),
    storage: new InMemoryStore(),
    agents: { assistant },
    mcpServers: { example: mcpServer },
    server: {
      // The same Better Auth instance the app mounts at /auth/*. Mastra's checkRouteAuth runs it
      // per route, so its public routes stay public and RBAC/FGA see the same sessions.
      auth: new MastraAuthBetterAuth({
        auth,
        // Mastra serves the OpenAPI document as an ordinary route under /api/*, which the default
        // config protects. Left alone, /docs loads for anonymous visitors but its spec fetch 401s.
        public: ['/api', '/api/auth/*', '/api/openapi.json'],
        // Without this, ownership checks fall back to the resource id the client sends, so one
        // authenticated user can read and write another's threads. Mastra warns about it at boot.
        mapUserToResourceId: betterAuthUser => betterAuthUser.user.id,
      }),
    },
  });
}
