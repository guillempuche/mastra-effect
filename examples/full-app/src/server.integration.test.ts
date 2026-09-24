import { toWebHandler, type EffectRouter } from '@guillem_puche/mastra-effect';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.ts';

const ORIGIN = 'http://localhost:3000';

let router: EffectRouter;

const send = async (path: string, init?: RequestInit): Promise<Response> => {
  const { handler, dispose } = toWebHandler(router);
  try {
    return await handler(new Request(`${ORIGIN}${path}`, init));
  } finally {
    await dispose();
  }
};

/** Signs a user up through Better Auth and returns the session cookie it issues. */
const signUp = async (email: string) => {
  const response = await send('/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Test User' }),
  });

  // `set-cookie` is `<name>=<value>; Path=/; HttpOnly; ...`. The leading pair is what a browser
  // sends back as `cookie`; the value on its own is the token the bearer-header test presents.
  const sessionCookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { response, cookie: sessionCookie, token: sessionCookie.split('=')[1] ?? '' };
};

beforeAll(async () => {
  router = await buildServer({ baseURL: ORIGIN, secret: 'test-secret-at-least-32-characters-long' });
});

describe('the assembled server', () => {
  describe('when nobody is signed in', () => {
    it("should serve the app's own route, which Mastra does not gate", async () => {
      // GIVEN a route the app registered directly on the router
      // WHEN it is requested without credentials
      // THEN it should answer normally, because Mastra's auth only covers Mastra's own routes
      const response = await send('/healthz');

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    });

    it('should reject a protected Mastra route', async () => {
      // GIVEN Better Auth is configured as Mastra's server auth
      // WHEN a Mastra route under the /api prefix is requested with no session
      // THEN it should be refused rather than served
      const response = await send('/api/agents');

      expect(response.status).toBe(401);
    });

    it('should serve the OpenAPI document Mastra generates', async () => {
      // GIVEN the adapter was constructed with openapiPath
      // WHEN the document is requested
      // THEN it should be a spec describing the mounted routes
      const response = await send('/api/openapi.json');
      const spec = (await response.json()) as { openapi?: string; paths?: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(spec.openapi ?? '').not.toBe('');
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
    });

    it('should serve the Scalar docs page pointed at that document', async () => {
      // GIVEN the docs route renders Scalar against Mastra's spec URL
      // WHEN the page is requested
      // THEN the returned HTML should reference the spec
      const response = await send('/docs');
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('/api/openapi.json');
      expect(html).toContain('api-reference');
    });
  });

  describe('when a user signs up through Better Auth', () => {
    it('should issue a session cookie from the route the app mounted', async () => {
      // GIVEN Better Auth is mounted at /auth/* as a foreign fetch handler
      // WHEN a sign-up is posted
      // THEN Better Auth should answer and set a session cookie
      const { response, cookie } = await signUp('cookie-user@example.com');

      expect(response.status).toBeLessThan(400);
      expect(cookie).toContain('session_token');
    });
  });

  describe('when a request carries a Better Auth session', () => {
    it('should allow a protected Mastra route using the session cookie', async () => {
      // GIVEN a signed-up user's session cookie
      // AND that the same Better Auth instance backs Mastra's server auth
      // WHEN a protected Mastra route is requested with that cookie
      // THEN Mastra should serve it, because both sides resolve the same session
      const { cookie } = await signUp('session-user@example.com');

      const response = await send('/api/agents', { headers: { cookie } });

      expect(response.status).toBe(200);
    });

    it('should allow a protected Mastra route using a bearer token', async () => {
      // GIVEN the session token extracted from the cookie
      // WHEN it is presented as an Authorization header instead
      // THEN it should be accepted too — Better Auth reads only cookies, so the provider
      // converts the bearer token into a signed session cookie before verifying
      const { token } = await signUp('bearer-user@example.com');

      const response = await send('/api/agents', { headers: { authorization: `Bearer ${token}` } });

      expect(response.status).toBe(200);
    });

    it('should still reject a token that was never issued', async () => {
      // GIVEN a syntactically plausible but unissued token
      // WHEN it is presented
      // THEN it should be refused
      const response = await send('/api/agents', { headers: { authorization: 'Bearer not-a-real-token' } });

      expect(response.status).toBe(401);
    });
  });

  describe('route precedence between the three mounted surfaces', () => {
    it('should route /auth/* to Better Auth rather than to Mastra', async () => {
      // GIVEN Better Auth and Mastra are registered on the same router
      // WHEN an /auth path is requested
      // THEN Better Auth should answer it, not Mastra's 404
      const response = await send('/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Better Auth rejects the empty body itself; a Mastra miss would look different.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });
});
