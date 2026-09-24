import { SERVER_ROUTES } from '@mastra/server/server-adapter';
import { describe, expect, it } from 'vitest';

import { eventForStatus, sanitizePath } from './observability.ts';

describe('sanitizePath', () => {
  describe('given a url carrying a secret in the query', () => {
    it('should drop the query string entirely', async () => {
      // GIVEN a magic-link url whose token rides in the query
      // WHEN the path is sanitized for a record
      // THEN no part of the token should survive
      const sanitized = sanitizePath('/auth/verify?token=super-secret-single-use-value&callback=/app');

      expect(sanitized).toBe('/auth/verify');
      expect(sanitized).not.toContain('token');
      expect(sanitized).not.toContain('super-secret-single-use-value');
    });

    it('should drop a fragment too', async () => {
      // GIVEN a url with a fragment
      // WHEN sanitized
      // THEN only the path should remain
      expect(sanitizePath('/docs#section')).toBe('/docs');
    });
  });

  describe('given identifiers in the path', () => {
    it('should collapse a uuid so records group by route', async () => {
      // GIVEN a path carrying a uuid
      // WHEN sanitized
      // THEN the id should be replaced, leaving a pattern that groups
      expect(sanitizePath('/api/agents/3f4a6c1e-9b2d-4f8a-bc11-7d9e2a5f0c33/generate')).toBe(
        '/api/agents/:id/generate',
      );
    });

    it('should collapse a numeric id', async () => {
      // GIVEN a numeric id segment
      // WHEN sanitized
      // THEN it should be replaced
      expect(sanitizePath('/api/threads/104857')).toBe('/api/threads/:id');
    });

    it('should collapse an email address, which is personal data even in a path', async () => {
      // GIVEN a path segment that is an address
      // WHEN sanitized
      // THEN it should never reach the record
      const sanitized = sanitizePath('/api/users/person@example.com/threads');

      expect(sanitized).toBe('/api/users/:id/threads');
      expect(sanitized).not.toContain('@');
    });

    it('should collapse an email that arrives percent-encoded', async () => {
      // GIVEN an address encoded as clients routinely encode `@` in a path segment
      // WHEN sanitized
      // THEN it should be collapsed just as the unencoded form is — `URL.pathname` preserves
      // the encoding, so a check against the raw segment would let the address through
      const sanitized = sanitizePath('/api/users/person%40example.com/threads');

      expect(sanitized).toBe('/api/users/:id/threads');
      expect(sanitized).not.toContain('example.com');
    });

    it('should leave a malformed escape alone rather than throwing', async () => {
      // GIVEN a segment that is not valid percent-encoding
      // WHEN sanitized
      // THEN decoding should fail softly and the segment should survive, because a logging
      // helper must never be the thing that breaks a request
      expect(sanitizePath('/api/x/%ZZbad')).toBe('/api/x/%ZZbad');
    });

    it('should collapse a long generated id that mixes digits and letters', async () => {
      // GIVEN a nanoid-shaped segment
      // WHEN sanitized
      // THEN it should be replaced
      expect(sanitizePath('/api/runs/V1StGXR8Z5jdHi6BmyT7x')).toBe('/api/runs/:id');
    });
  });

  describe('given real route names', () => {
    it('should keep a hyphenated name that is long but not an id', async () => {
      // GIVEN route names long enough to trip a naive length rule
      // WHEN sanitized
      // THEN they should survive, or unrelated routes would merge into one bucket
      expect(sanitizePath('/api/background-tasks/stream')).toBe('/api/background-tasks/stream');
      expect(sanitizePath('/api/observational-memory')).toBe('/api/observational-memory');
    });

    it('should keep a dotted filename', async () => {
      // GIVEN the generated OpenAPI document's path
      // WHEN sanitized
      // THEN it should be recorded as itself
      expect(sanitizePath('/api/openapi.json')).toBe('/api/openapi.json');
    });

    it('should leave the root path alone', async () => {
      // GIVEN the root path
      // WHEN sanitized
      // THEN it should stay usable as a pattern
      expect(sanitizePath('/')).toBe('/');
    });

    it('should not collapse any literal segment of any real Mastra route', async () => {
      // GIVEN every route Mastra actually registers
      // WHEN each literal segment is sanitized
      // THEN none should be mistaken for an identifier, since that would merge distinct
      // routes into one unreadable bucket
      const literalSegments = new Set<string>();
      for (const route of SERVER_ROUTES) {
        for (const segment of route.path.split('/')) {
          if (segment !== '' && !segment.startsWith(':') && !segment.startsWith('*')) {
            literalSegments.add(segment);
          }
        }
      }

      const collapsed = [...literalSegments].filter(segment => sanitizePath(`/${segment}`) === '/:id');

      expect(literalSegments.size).toBeGreaterThan(50);
      expect(collapsed).toEqual([]);
    });
  });
});

describe('eventForStatus', () => {
  describe('given how a request ended', () => {
    it('should name a completed request', async () => {
      // GIVEN a request that succeeded
      // THEN it should close the ordinary record
      expect(eventForStatus(200)).toBe('http.request');
    });

    it('should separate a server error so failures can be counted alone', async () => {
      // GIVEN a 5xx
      // THEN it should be its own event
      expect(eventForStatus(500)).toBe('http.server_error');
      expect(eventForStatus(503)).toBe('http.server_error');
    });

    it('should keep a missing route out of the error channel', async () => {
      // GIVEN a request for a route that does not exist
      // THEN it should be its own event rather than an error — otherwise every bot probing
      // for /robots.txt buries the failures that matter
      expect(eventForStatus(404)).toBe('http.not_found');
    });

    it('should not treat a client error as a server failure', async () => {
      // GIVEN a 401 from the auth gate
      // THEN it should close the ordinary record, since it is the caller's problem
      expect(eventForStatus(401)).toBe('http.request');
      expect(eventForStatus(400)).toBe('http.request');
    });
  });
});
