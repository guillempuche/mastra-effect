import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

export type { Auth };

/**
 * The Better Auth instance is owned by the Effect app, not by Mastra.
 *
 * The app needs a handle on it to mount `/auth/*` on its own router, and the same instance is
 * handed to `MastraAuthBetterAuth` so Mastra's per-route auth, RBAC and FGA resolve against the
 * very same sessions. One identity system, two consumers.
 *
 * `MastraAuthBetterAuth` can build its own instance from just a `secret`, but then the app has no
 * way to serve the sign-in endpoints and you end up with two auth surfaces.
 */
export function createAuth(options: { baseURL: string; secret: string }): Auth {
  // Annotated as BetterAuthOptions rather than passed inline: betterAuth() otherwise infers
  // Auth<{these exact options}>, and Auth's generic is invariant, so that narrower type is not
  // assignable to the plain Auth that MastraAuthBetterAuth accepts.
  const config: BetterAuthOptions = {
    baseURL: options.baseURL,
    basePath: '/auth',
    secret: options.secret,
    // In-memory so the example runs with no database and no containers. Swap for the libsql or
    // Postgres adapter in production — nothing else here changes.
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
  };

  return betterAuth(config);
}
