/**
 * SERVER_ROUTES contains four pairs that share a static prefix but name their param
 * differently at the same segment (`/stored/agents/:agentId/versions` vs
 * `/stored/agents/:storedAgentId`, and the same for mcp-clients, prompt-blocks, scorers).
 *
 * Stock find-my-way throws on these. rc.117 vendors its own FindMyWay, so the behavior has
 * to be measured, not assumed: whether registration is accepted matters far less than whether
 * dispatch delivers the *correct param name* to each route. A silent overwrite would hand
 * Mastra's handler `agentId` where it expects `storedAgentId`.
 *
 * This decides whether the adapter needs Elysia's `:p0` normalization
 * (server-adapters/elysia/src/index.ts:33-56).
 */
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http';
import { describe, expect, it } from 'vitest';

/** Echoes back whatever path params the router bound, so we can see the names. */
const echoParams = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  return HttpServerResponse.jsonUnsafe(params);
});

async function buildRouter(paths: ReadonlyArray<string>) {
  const router = Effect.runSync(HttpRouter.make);
  for (const path of paths) {
    await Effect.runPromise(router.add('GET', path as `/${string}`, echoParams));
  }
  return HttpRouter.toWebHandler(Layer.succeed(HttpRouter.HttpRouter)(router));
}

describe('rc.117 router: differing param names at the same segment', () => {
  it('accepts both registrations without throwing', async () => {
    await expect(
      buildRouter(['/stored/agents/:agentId/versions', '/stored/agents/:storedAgentId']),
    ).resolves.toBeDefined();
  });

  it('binds the correct param NAME for each colliding route', async () => {
    const { handler, dispose } = await buildRouter([
      '/stored/agents/:agentId/versions',
      '/stored/agents/:storedAgentId',
    ]);

    try {
      const versions = await handler(new Request('http://localhost/stored/agents/a1/versions'));
      const stored = await handler(new Request('http://localhost/stored/agents/a1'));

      const versionsParams = await versions.json();
      const storedParams = await stored.json();

      // The failure mode we care about: `stored` coming back as { agentId: 'a1' }.
      expect(versionsParams).toEqual({ agentId: 'a1' });
      expect(storedParams).toEqual({ storedAgentId: 'a1' });
    } finally {
      await dispose();
    }
  });

  it('keeps a literal segment ahead of a param at the same position', async () => {
    const { handler, dispose } = await buildRouter([
      '/stored/agents/preview-instructions',
      '/stored/agents/:storedAgentId',
    ]);

    try {
      const literal = await handler(new Request('http://localhost/stored/agents/preview-instructions'));
      expect(await literal.json()).toEqual({});
    } finally {
      await dispose();
    }
  });
});
