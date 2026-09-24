import { toWebHandler, type EffectRouter } from '@guillem_puche/mastra-effect';
import type { Mastra } from '@mastra/core';
import type { IMastraLogger } from '@mastra/core/logger';
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildServer } from './server.ts';

const KEY = 'test-key';

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
const withKey = (key: string): RequestInit => ({ headers: { 'x-api-key': key } });

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
  ({ router, mastra } = await buildServer({ apiKey: KEY }));
  loggedRequests.watch(mastra);
});

beforeEach(() => loggedRequests.clear());

describe('Mastra mounted as one route', () => {
  describe("when the app's own route is requested", () => {
    it('should answer without any key, and stay out of Mastra\'s log', async () => {
      // GIVEN the key check wraps only the forward to Mastra
      // WHEN the app's own route is requested with no key
      // THEN the app should answer
      const response = await send('/healthz');

      expect(response.status).toBe(200);
      // AND Mastra's log, which lives on Mastra's own router, should never see it
      expect(loggedRequests.lines()).toEqual([]);
    });
  });

  describe('when /api is requested without a valid key', () => {
    it.each([
      ['no key', undefined],
      ['a wrong key', withKey('not-the-key')],
      ['an empty key', withKey('')],
    ])('should refuse %s with 401', async (_case, init) => {
      // GIVEN Mastra is reachable only through the key check
      // WHEN a request arrives with <case>
      // THEN it should be refused before Mastra sees it
      const response = await send('/api/agents', init);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Missing or wrong x-api-key' });
    });

    it('should refuse the key when it is sent in the query string instead of the header', async () => {
      // GIVEN the check reads only the x-api-key header
      // WHEN the key is put in the URL, where it would end up in logs and browser history
      // THEN it should not count
      const response = await send(`/api/agents?x-api-key=${KEY}`);

      expect(response.status).toBe(401);
    });

    it('should refuse even a path Mastra does not have, rather than reveal that with a 404', async () => {
      // GIVEN the check runs before Mastra's router looks at the path
      // WHEN an unknown path under /api is requested without a key
      // THEN the answer should be 401, saying nothing about which paths exist
      const response = await send('/api/nope');

      expect(response.status).toBe(401);
    });

    it("should not reach Mastra's log", async () => {
      // GIVEN the refusal happens in the app's router, in front of Mastra
      // WHEN a request is refused
      // THEN Mastra should have no record of it
      await send('/api/agents');

      expect(loggedRequests.lines()).toEqual([]);
    });
  });

  describe('when /api is requested with the right key', () => {
    it('should reach Mastra with the full path intact', async () => {
      // GIVEN the forward passes the URL through unchanged
      // WHEN the agent list is requested with the key
      // THEN Mastra should match /api/agents and answer
      const response = await send('/api/agents', withKey(KEY));

      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()) as object)).toContain('assistant');
    });

    it('should accept the header name in any case', async () => {
      // GIVEN HTTP header names are case-insensitive
      // WHEN the key is sent as X-API-KEY
      // THEN it should be accepted
      const response = await send('/api/agents', { headers: { 'X-API-KEY': KEY } });

      expect(response.status).toBe(200);
    });

    it("should bind Mastra's path parameters as if Mastra owned the server", async () => {
      // GIVEN a Mastra route with a parameter, behind the forward
      // WHEN it is requested
      // THEN Mastra should receive the parameter
      const response = await send('/api/agents/assistant', withKey(KEY));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { name?: string }).name).toBe('assistant');
    });

    it('should answer 404 for a path Mastra does not have', async () => {
      // GIVEN the forward passes every /api path to Mastra's router
      // WHEN Mastra has no route for it
      // THEN it should be a 404, not a server error
      const response = await send('/api/nope', withKey(KEY));

      expect(response.status).toBe(404);
    });

    it("should be recorded in Mastra's log", async () => {
      // GIVEN request logging is on in Mastra's config
      // WHEN a request is forwarded to Mastra
      // THEN Mastra's log should record it
      await send('/api/agents', withKey(KEY));

      expect(loggedRequests.lines()).toEqual([expect.stringMatching(/^GET \/api\/agents 200 /)]);
    });
  });

  describe("when Mastra's custom route is called", () => {
    const echo = (target: EffectRouter) =>
      sendTo(target, '/hooks/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });

    it('should answer without a key while its prefix is forwarded', async () => {
      // GIVEN /hooks/* is forwarded to Mastra, deliberately without the key check
      // WHEN the hook is called with no key
      // THEN Mastra should answer it
      const response = await echo(router);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: { a: 1 } });
    });

    it('should answer 404 once its prefix is no longer forwarded', async () => {
      // GIVEN a server that forwards only /api/*
      const unforwarded = await buildServer({ apiKey: KEY, customRoutePrefixes: [] });

      // WHEN the hook — which Mastra refuses to put under /api — is called
      const response = await echo(unforwarded.router);

      // THEN nothing should reach it
      expect(response.status).toBe(404);
    });
  });

  describe('when the server is misconfigured', () => {
    it.each([
      ['a blank key', { apiKey: '' }, /apiKey must not be blank/],
      ['a whitespace key', { apiKey: '   ' }, /apiKey must not be blank/],
      ['a trailing slash on a prefix', { apiKey: KEY, customRoutePrefixes: ['/hooks/'] as const }, /trailing slash/],
    ])('should refuse to start with %s', async (_case, options, message) => {
      // GIVEN a setting that would quietly open the check, or quietly 404 every hook
      // WHEN the server is built with it
      // THEN it should fail at startup instead
      await expect(buildServer(options)).rejects.toThrow(message);
    });
  });
});
