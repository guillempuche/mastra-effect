/**
 * MCP served through the adapter, on a real Node server.
 *
 * Three defects lived here, each reproduced before its fix: a client that disconnected left the
 * transport's keep-alive timer writing into a closed stream, an uncatchable error that ends the
 * process; the caller Mastra's auth had resolved never reached MCP tools; and a transport that
 * failed to start left the request unanswered.
 */
import { Mastra } from '@mastra/core';
import { SimpleAuth } from '@mastra/core/server';
import { createTool } from '@mastra/core/tools';
import { MCPClient, MCPServer as MCPServerV2 } from '@mastra/mcp';
// 1.x, where streamable HTTP keeps sessions open between requests — the shape the disconnect and
// start-failure defects needed. Mastra's own MCP transport suite, in conformance.test.ts, runs 2.x.
import { MCPServer } from '@mastra/mcp-v1';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MastraServer, createRouter } from './index';
import { onNodeServer, type NodeServer } from './test-support';

/** Reports the auth info the MCP transport handed the tool, so a test can see who it thinks called. */
const whoami = createTool({
  id: 'whoami',
  description: 'Returns the caller the MCP transport passed in',
  inputSchema: z.object({}),
  execute: async (_input, context) => ({
    authInfo: (context as { mcp?: { extra?: { authInfo?: unknown } } } | undefined)?.mcp?.extra?.authInfo ?? null,
  }),
});

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

let server: NodeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const serve = async (mastra: Mastra, mcpOptions?: Record<string, unknown>) => {
  const router = createRouter();
  await new MastraServer({ app: router, mastra, ...(mcpOptions ? { mcpOptions } : {}) } as never).init();
  server = await onNodeServer(router);
  return server;
};

/** Opens a session: initialize, then the notification the protocol requires before anything else. */
const openSession = async (origin: string, headers: Record<string, string> = HEADERS) => {
  const response = await fetch(`${origin}/api/mcp/s/mcp`, { method: 'POST', headers, body: JSON.stringify(initialize) });
  const session = response.headers.get('mcp-session-id') ?? '';
  await response.text();
  await fetch(`${origin}/api/mcp/s/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': session },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).then(r => r.text());
  return { status: response.status, session };
};

describe('an MCP client that disconnects', () => {
  it("should not crash the process when the transport's keep-alive fires afterwards", async () => {
    // GIVEN a session with its event stream open, and a keep-alive short enough to observe
    const { origin } = await serve(
      new Mastra({ mcpServers: { s: new MCPServer({ id: 's', name: 's', version: '1', tools: { whoami } }) } }),
      { keepAliveMs: 100 },
    );
    const { session } = await openSession(origin);
    const errors: unknown[] = [];
    const record = (error: unknown) => errors.push(error);
    process.on('uncaughtException', record);
    process.on('unhandledRejection', record);

    try {
      const client = new AbortController();
      const events = await fetch(`${origin}/api/mcp/s/mcp`, {
        headers: { accept: 'text/event-stream', 'mcp-session-id': session },
        signal: client.signal,
      });
      expect(events.status).toBe(200);

      // WHEN the client goes away, and several keep-alive intervals pass
      client.abort();
      await new Promise(resolve => setTimeout(resolve, 600));

      // THEN nothing should have been thrown where nothing can catch it
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
    }
  });
});

describe("an MCP tool's caller", () => {
  const authed = (server: unknown) =>
    new Mastra({
      server: { auth: new SimpleAuth({ tokens: { 'token-1': { id: 'user-1' } } }) },
      mcpServers: { s: server },
    } as never);
  const signedIn = { ...HEADERS, authorization: 'Bearer token-1' };

  /** Over the 2025 protocol by hand: a 1.x server keeps a session between requests. */
  const callWhoamiV1 = async (origin: string) => {
    const { session } = await openSession(origin, signedIn);
    const response = await fetch(`${origin}/api/mcp/s/mcp`, {
      method: 'POST',
      headers: { ...signedIn, 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    return response.text();
  };

  /** Through Mastra's own client: a 2.x server only speaks the newer protocol. */
  const callWhoamiV2 = async (origin: string) => {
    const client = new MCPClient({
      id: `whoami-${origin}`,
      servers: { s: { url: new URL(`${origin}/api/mcp/s/mcp`), requestInit: { headers: { authorization: 'Bearer token-1' } } } },
    });
    try {
      const tools = await client.listTools();
      const whoamiTool = Object.values(tools)[0] as { execute: (input: object, context: object) => Promise<unknown> };
      return JSON.stringify(await whoamiTool.execute({}, {}));
    } finally {
      await client.disconnect();
    }
  };

  const versions = [
    ['@mastra/mcp 1.x', () => new MCPServer({ id: 's', name: 's', version: '1', tools: { whoami } }), callWhoamiV1],
    ['@mastra/mcp 2.x', () => new MCPServerV2({ id: 's', name: 's', version: '1', tools: { whoami } }), callWhoamiV2],
  ] as const;

  it.each(versions)('should be the user Mastra authenticated, with %s', async (_version, makeServer, callWhoami) => {
    // GIVEN Mastra authenticates callers, and a signed-in client
    const { origin } = await serve(authed(makeServer()));

    // WHEN it calls a tool
    const body = await callWhoami(origin);

    // THEN the tool should see that caller, as it does under @mastra/hono
    expect(body).toContain('user-1');
  });

  it.each(versions)("should come from the app's setRequestAuth hook when one is given, with %s", async (_version, makeServer, callWhoami) => {
    // GIVEN a hook that decides what the transport sees
    let calls = 0;
    const { origin } = await serve(authed(makeServer()), {
      setRequestAuth: (req: { auth?: unknown }) => {
        calls++;
        req.auth = { token: 'from-hook', clientId: 'hook-client', scopes: [] };
      },
    });

    // WHEN a tool is called
    const body = await callWhoami(origin);

    // THEN the hook should have run, and the tool should see what it set
    expect(calls).toBeGreaterThan(0);
    expect(body).toContain('hook-client');
  });
});

describe('an MCP transport that fails to start', () => {
  it('should answer with a JSON-RPC error instead of leaving the client waiting', async () => {
    // GIVEN transport options this protocol version rejects, so starting fails before any header
    const { origin } = await serve(
      new Mastra({
        mcpServers: {
          s: new MCPServer({ id: 's', name: 's', version: '1', tools: { whoami }, protocolVersion: '2026-07-28' } as never),
        },
      }),
      { serverless: false },
    );

    // WHEN a client initializes
    const response = await fetch(`${origin}/api/mcp/s/mcp`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(initialize),
      signal: AbortSignal.timeout(5_000),
    });

    // THEN it should get a prompt server error in the protocol it speaks
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32603 } });
  });
});
