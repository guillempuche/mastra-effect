import { createRouter } from '@guillem_puche/mastra-effect';
import { Effect, Layer, Logger, References } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http';
import { describe, expect, it } from 'vitest';

import { recordRequests } from './observability.ts';

/** Serves a router with a logger that keeps each record's annotations, and returns what it kept. */
const recordsFor = async (path: string) => {
  const records: Array<Record<string, unknown>> = [];
  const capture = Logger.make(({ fiber }) => {
    records.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
  });

  const router = createRouter();
  recordRequests(router);
  await Effect.runPromise(router.add('GET', '/hello', HttpServerResponse.text('hi')));

  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(Layer.succeed(HttpRouter.HttpRouter)(router), Logger.layer([capture])),
    { disableLogger: true },
  );
  try {
    const response = await handler(new Request(`http://localhost${path}`));
    return { status: response.status, records: records.filter(record => 'http.status' in record) };
  } finally {
    await dispose();
  }
};

describe('recordRequests', () => {
  it('should write one record for a request a route answered', async () => {
    // GIVEN a route that answers (not /healthz, whose successful polls are logged below the default level)
    // WHEN it is requested
    const { records } = await recordsFor('/hello');

    // THEN exactly one record should describe it
    expect(records).toEqual([expect.objectContaining({ event: 'http.request', 'http.status': 200 })]);
  });

  it('should record a path no route matched as not found, rather than skipping it', async () => {
    // GIVEN no route for the path — the probe a bot sends for /robots.txt
    // WHEN it is requested
    const { status, records } = await recordsFor('/robots.txt');

    // THEN it should be answered 404 and still leave its one record, outside the error channel
    expect(status).toBe(404);
    expect(records).toEqual([
      expect.objectContaining({ event: 'http.not_found', 'http.status': 404, 'http.path_pattern': '/robots.txt' }),
    ]);
  });
});
