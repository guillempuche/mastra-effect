import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { afterEach, describe, expect, it } from 'vitest';

import entry from './entry.ts';
import { createFetchHandler, type FetchHandler } from './handler.ts';
import { createMastra } from './mastra.ts';

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

/** A Mastra that is created fine but fails to start: Mastra refuses custom routes under /api. */
const mastraThatFailsToStart = () =>
  new Mastra({
    server: { apiRoutes: [registerApiRoute('/api/clash', { method: 'GET', handler: c => c.text('never') })] },
  });

/** Wraps a sequence of Mastra factories, counting how many Mastra instances were asked for. */
const factories = (...makers: Array<() => Mastra>) => {
  let calls = 0;
  return {
    make: () => {
      const maker = makers[Math.min(calls, makers.length - 1)] ?? createMastra;
      calls++;
      return maker();
    },
    get calls() {
      return calls;
    },
  };
};

let handlers: FetchHandler[] = [];
const track = (handler: FetchHandler) => (handlers.push(handler), handler);

afterEach(async () => {
  await Promise.all(handlers.map(handler => handler.dispose()));
  handlers = [];
});

describe('the fetch handler', () => {
  describe('before any request', () => {
    it('should not start Mastra just by being created', () => {
      // GIVEN a factory that counts the Mastra instances it makes
      const counted = factories(createMastra);

      // WHEN the handler is created and nothing is requested
      track(createFetchHandler(counted.make));

      // THEN no Mastra should exist yet
      expect(counted.calls).toBe(0);
    });

    it('should shut down cleanly without ever having started', async () => {
      // GIVEN a handler that never served a request
      const counted = factories(createMastra);
      const handler = createFetchHandler(counted.make);

      // WHEN it is disposed
      await handler.dispose();

      // THEN nothing should have been started just to be stopped
      expect(counted.calls).toBe(0);
    });
  });

  describe('on the first request', () => {
    it("should start Mastra and answer from Mastra's routes", async () => {
      // GIVEN a fresh handler
      const { fetch } = track(createFetchHandler());

      // WHEN it receives its first request
      const response = await fetch(request('/api/agents'));

      // THEN Mastra should answer it
      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()) as object)).toContain('assistant');
    });

    it('should run the workflow end to end from a POST body', async () => {
      // GIVEN a handler whose Mastra has a workflow needing no API key
      const { fetch } = track(createFetchHandler());

      // WHEN the workflow is started through the plain function
      const response = await fetch(
        request('/api/workflows/greet/start-async', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputData: { name: 'Ada' } }),
        }),
      );

      // THEN the body should have reached Mastra and the workflow run
      expect(((await response.json()) as { result?: { greeting?: string } }).result?.greeting).toBe('Hello, Ada!');
    });
  });

  describe('when several first requests arrive at once', () => {
    it('should start Mastra once and answer them all', async () => {
      // GIVEN a fresh handler counting Mastra instances
      const counted = factories(createMastra);
      const { fetch } = track(createFetchHandler(counted.make));

      // WHEN three requests arrive before Mastra has started
      const responses = await Promise.all([1, 2, 3].map(() => fetch(request('/api/agents'))));

      // THEN all should be answered by a single Mastra
      expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
      expect(counted.calls).toBe(1);
    });
  });

  describe('when starting fails', () => {
    it.each([
      ['Mastra fails to start', mastraThatFailsToStart],
      [
        'the factory itself throws',
        () => {
          throw new Error('factory exploded');
        },
      ],
    ])('should fail that request, then retry on the next one — when %s', async (_case, failing) => {
      // GIVEN a first start that fails, and a second that works
      const counted = factories(failing, createMastra);
      const { fetch } = track(createFetchHandler(counted.make));

      // WHEN a request arrives, and then another
      await expect(fetch(request('/api/agents'))).rejects.toThrow();
      const retried = await fetch(request('/api/agents'));

      // THEN the second should succeed on a fresh start rather than repeat the old failure
      expect(retried.status).toBe(200);
      expect(counted.calls).toBe(2);
    });

    it('should let dispose finish while a start is failing, since that start holds nothing to release', async () => {
      // GIVEN a request whose start is still in progress and about to fail
      const handler = createFetchHandler(factories(mastraThatFailsToStart).make);
      const failed = expect(handler.fetch(request('/api/agents'))).rejects.toThrow();

      // WHEN the handler is disposed before that start has settled
      // THEN dispose should complete, rather than resurface the start's error to whoever shuts down
      await expect(handler.dispose()).resolves.toBeUndefined();
      await failed;
    });
  });

  describe('after dispose', () => {
    it('should start a fresh Mastra on the next request', async () => {
      // GIVEN a handler that has served and been disposed
      const counted = factories(createMastra);
      const handler = track(createFetchHandler(counted.make));
      await handler.fetch(request('/api/agents'));
      await handler.dispose();

      // WHEN another request arrives
      const response = await handler.fetch(request('/api/agents'));

      // THEN it should be served by a new Mastra
      expect(response.status).toBe(200);
      expect(counted.calls).toBe(2);
    });

    it('should not orphan a Mastra when dispose lands while a start is failing', async () => {
      // GIVEN a start that is about to fail
      const counted = factories(mastraThatFailsToStart, createMastra);
      const handler = track(createFetchHandler(counted.make));
      const failing = handler.fetch(request('/api/agents'));

      // WHEN the handler is disposed, and a new request starts a second Mastra, all before the
      // first start has failed
      const disposed = handler.dispose();
      const second = handler.fetch(request('/api/agents'));
      await expect(failing).rejects.toThrow();
      await disposed;
      await second;
      await handler.fetch(request('/api/agents'));

      // THEN the later request should reuse the second Mastra, not start a third and leave the
      // second running with nothing left to dispose it
      expect(counted.calls).toBe(2);
    });
  });

  describe('when a framework passes extra arguments', () => {
    it('should ignore them, as with the route params Next.js passes', async () => {
      // GIVEN a handler, called the way Next.js calls route handlers
      const { fetch } = track(createFetchHandler());
      const asNextCallsIt = fetch as (request: Request, context: unknown) => Promise<Response>;

      // WHEN a second argument comes along with the request
      const response = await asNextCallsIt(request('/api/agents'), { params: Promise.resolve({}) });

      // THEN it should make no difference
      expect(response.status).toBe(200);
    });
  });

  describe("the entry module's default export", () => {
    it('should be the { fetch } object Bun, Deno and Workers expect, and answer', async () => {
      // GIVEN the module a platform would load
      // WHEN its default export is called like a platform calls it
      const response = await entry.fetch(request('/api/agents'));

      // THEN Mastra should answer
      expect(response.status).toBe(200);
    });
  });
});
