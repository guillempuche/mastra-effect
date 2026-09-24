import { createServer as createNetServer } from 'node:net';

import { toWebHandler, type EffectRouter } from '@guillem_puche/mastra-effect';
import { Effect, ManagedRuntime } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildServer, serve } from './server.ts';

let router: EffectRouter;

const send = async (path: string, init?: RequestInit): Promise<Response> => {
  const { handler, dispose } = toWebHandler(router);
  try {
    return await handler(new Request(`http://localhost${path}`, init));
  } finally {
    await dispose();
  }
};

const startWorkflow = (body: string) =>
  send('/api/workflows/greet/start-async', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

/** Asks the OS for a port nobody is using, then gives it back so the server can take it. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });

beforeAll(async () => {
  router = await buildServer();
});

describe('the minimal server', () => {
  describe('when asked what Mastra offers', () => {
    it("should list Mastra's agents under /api", async () => {
      // GIVEN the server built with its defaults
      // WHEN the agent list is requested
      // THEN it should include the agent defined in mastra.ts
      const response = await send('/api/agents');

      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()) as object)).toContain('assistant');
    });
  });

  describe('when the greet workflow is started', () => {
    it('should run it end to end and return the greeting, with no API key set', async () => {
      // GIVEN a workflow that needs no AI provider
      // WHEN it is started with a valid name
      // THEN Mastra should have executed it and returned its result
      const response = await startWorkflow(JSON.stringify({ inputData: { name: 'Ada' } }));
      const run = (await response.json()) as { status?: string; result?: { greeting?: string } };

      expect(response.status).toBe(200);
      expect(run.status).toBe('success');
      expect(run.result?.greeting).toBe('Hello, Ada!');
    });

    it("should refuse an empty name with 400, because the workflow's schema requires one", async () => {
      // GIVEN the workflow's input schema requires a non-empty name
      // WHEN it is started with an empty one
      // THEN it should be refused before running
      const response = await startWorkflow(JSON.stringify({ inputData: { name: '' } }));

      expect(response.status).toBe(400);
    });

    it('should refuse a request with no input at all with 400', async () => {
      // GIVEN a body that carries no inputData
      // WHEN the workflow is started
      // THEN it should be refused rather than run with nothing
      const response = await startWorkflow('{}');

      expect(response.status).toBe(400);
    });

    it('should refuse a body that is not valid JSON with 400', async () => {
      // GIVEN a JSON content-type with a body that does not parse
      // WHEN the workflow is started
      // THEN the caller should be told the request was bad, not see a server error
      const response = await startWorkflow('{not json');

      expect(response.status).toBe(400);
    });
  });

  describe('when nothing lives at the requested path', () => {
    it.each([
      ['a Mastra path without the /api prefix', '/agents'],
      ['a workflow that does not exist', '/api/workflows/nope'],
      ['a doubled slash', '/api//agents'],
    ])('should answer 404 for %s', async (_case, path) => {
      // GIVEN every Mastra route lives under /api, exactly
      // WHEN a path outside that is requested
      // THEN it should be not found
      const response = await send(path);

      expect(response.status).toBe(404);
    });
  });

  describe('when served on a real Node port', () => {
    it('should answer over HTTP, and stop answering once shut down', async () => {
      // GIVEN the server started on a free port, exactly as `pnpm dev` starts it
      const port = await freePort();
      const runtime = ManagedRuntime.make(serve(router, port));
      await runtime.runPromise(Effect.void);

      try {
        // WHEN a real HTTP request reaches it
        const response = await fetch(`http://127.0.0.1:${port}/api/agents`);

        // THEN Mastra should answer
        expect(response.status).toBe(200);
      } finally {
        await runtime.dispose();
      }

      // AND the port should be closed after shutdown
      await expect(fetch(`http://127.0.0.1:${port}/api/agents`)).rejects.toThrow();
    });
  });
});
