import { toWebHandler, type EffectRouter } from '@guillem_puche/mastra-effect';
import type { Mastra } from '@mastra/core';
import type { IMastraLogger } from '@mastra/core/logger';
import { Effect } from 'effect';
import { HttpServerResponse } from 'effect/unstable/http';
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildServer } from './server.ts';

let router: EffectRouter;
let mastra: Mastra;

const sendTo = async (target: EffectRouter, path: string, init?: RequestInit): Promise<Response> => {
  const { handler, dispose } = toWebHandler(target);
  try {
    return await handler(new Request(`http://localhost${path}`, init));
  } finally {
    await dispose();
  }
};
const send = (path: string, init?: RequestInit) => sendTo(router, path, init);

const postJson = (path: string, body: string) =>
  send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

/**
 * The request lines Mastra's request log has written.
 *
 * The log writes through a child logger the adapter derives from `mastra.getLogger()`, not through
 * that logger itself — so that is the one to watch. `logger` is protected, hence the cast.
 */
const loggedRequests = (() => {
  let info: MockInstance<IMastraLogger['info']> | undefined;
  return {
    watch(target: Mastra) {
      const logger = (target.getMastraServer() as unknown as { logger: IMastraLogger }).logger;
      info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    },
    clear: () => info?.mockClear(),
    lines: () => (info?.mock.calls ?? []).map(([message]) => String(message)),
  };
})();

beforeAll(async () => {
  ({ router, mastra } = await buildServer());
  loggedRequests.watch(mastra);
});

beforeEach(() => loggedRequests.clear());

describe('Mastra alongside your routes', () => {
  describe("when the app's own routes are requested", () => {
    it('should answer the health check', async () => {
      // GIVEN a route the app added to the router itself
      // WHEN it is requested
      // THEN the app should answer, not Mastra
      const response = await send('/healthz');

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    });

    it('should read the path parameter, decoded', async () => {
      // GIVEN an app route with a path parameter
      // WHEN it is requested with an encoded value
      // THEN the handler should receive it decoded
      const response = await send('/users/a%20b');

      expect(await response.json()).toEqual({ id: 'a b' });
    });
  });

  describe("when Mastra's routes are requested on the same router", () => {
    it("should serve Mastra's API", async () => {
      // GIVEN Mastra added its routes to the app's router
      // WHEN one of them is requested
      // THEN Mastra should answer it
      const response = await send('/api/agents');

      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()) as object)).toContain('assistant');
    });
  });

  describe('the middleware added to the router', () => {
    it.each([
      ["the app's route", '/healthz'],
      ["Mastra's route", '/api/agents'],
      ['a 404 that a Mastra route itself returns', '/api/agents/missing'],
    ])('should wrap %s', async (_case, path) => {
      // GIVEN one middleware added to the shared router
      // WHEN any route on it answers — even with an error of its own
      // THEN the middleware should have run
      const response = await send(path);

      expect(response.headers.get('x-served-by')).toBe('effect');
    });

    it('should stamp even a request that fails instead of producing a response', async () => {
      // GIVEN the middleware stamps through a pre-response handler, which runs on every answer sent
      // WHEN a request matches no route, so it fails in Effect — as a Mastra server error does too
      // THEN the router's 404 should carry the stamp all the same
      const response = await send('/nowhere');

      expect(response.status).toBe(404);
      expect(response.headers.get('x-served-by')).toBe('effect');
    });
  });

  describe("when Mastra's custom route is called", () => {
    it('should echo a JSON body', async () => {
      // GIVEN a custom route defined in Mastra's config, outside /api
      // WHEN it receives JSON
      // THEN it should answer through the same router as everything else
      const response = await postJson('/hooks/echo', '{"a":1}');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: { a: 1 } });
    });

    it('should refuse an empty body with 400', async () => {
      // GIVEN the hook needs a JSON body
      // WHEN it receives none
      // THEN the caller should be told, rather than see a server error
      const response = await postJson('/hooks/echo', '');

      expect(response.status).toBe(400);
    });

    it('should not answer a method it was not defined for', async () => {
      // GIVEN the hook is defined for POST only
      // WHEN it is requested with GET
      // THEN nothing should answer
      const response = await send('/hooks/echo');

      expect(response.status).toBe(404);
    });
  });

  describe('when routes are added after Mastra', () => {
    it('should serve them, wrapped by the same middleware', async () => {
      // GIVEN a server whose Mastra routes are already in place
      const late = await buildServer();

      // WHEN the app adds another route afterwards
      await Effect.runPromise(late.router.add('GET', '/late', HttpServerResponse.text('late')));
      const response = await sendTo(late.router, '/late');

      // THEN it should answer like any other route, because order does not decide matching
      expect(await response.text()).toBe('late');
      expect(response.headers.get('x-served-by')).toBe('effect');
    });
  });

  describe("when the app adds a route at a path Mastra already uses", () => {
    it('should refuse it loudly, and keep serving Mastra there', async () => {
      // GIVEN Mastra already answers GET /api/agents
      const clash = await buildServer();

      // WHEN the app tries to add its own GET /api/agents
      const adding = Effect.runPromise(clash.router.add('GET', '/api/agents', HttpServerResponse.text('mine')));

      // THEN registration should fail rather than silently replace or shadow Mastra's route
      await expect(adding).rejects.toThrow(/already declared/);
      // AND Mastra should still answer there
      expect((await sendTo(clash.router, '/api/agents')).status).toBe(200);
    });
  });

  describe("Mastra's request log", () => {
    it.each([
      ["the app's own route", '/users/1'],
      ["Mastra's route", '/api/agents'],
    ])('should record %s, since everything shares one router', async (_case, path) => {
      // GIVEN request logging turned on in Mastra's config
      // WHEN a route on the shared router is requested
      // THEN the log should record it, whoever owns the route
      await send(path);

      expect(loggedRequests.lines()).toEqual([expect.stringMatching(new RegExp(`^GET ${path} 200 `))]);
    });

    it('should leave out a path listed in excludePaths', async () => {
      // GIVEN /healthz is listed in excludePaths
      // WHEN it is requested
      // THEN nothing should be logged
      await send('/healthz');

      expect(loggedRequests.lines()).toEqual([]);
    });

    it('should still record an excluded path requested in different case', async () => {
      // GIVEN excludePaths compares paths exactly while the router ignores case
      // WHEN /HEALTHZ is requested
      // THEN it is served — and logged, despite the exclusion
      const response = await send('/HEALTHZ');

      expect(response.status).toBe(200);
      expect(loggedRequests.lines()).toHaveLength(1);
    });

    it('should record a request that matched no route, with the 404 it gets', async () => {
      // GIVEN request logging on
      // WHEN a request matches no route at all
      // THEN it should still be recorded, as under @mastra/hono — a probe for a missing path is
      // exactly what a request log is for
      await send('/nowhere');

      expect(loggedRequests.lines()).toEqual([expect.stringMatching(/^GET \/nowhere 404 /)]);
    });
  });
});
