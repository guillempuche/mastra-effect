/**
 * Compile-time contract against `effect/unstable/http`. Not part of the public entry —
 * it exists so that an Effect upgrade fails `tsc` here rather than somewhere subtle at runtime.
 *
 * Pinned at effect@4.0.0-rc.116.
 */
import { Effect, Layer, Stream } from 'effect';
import { Sse } from 'effect/unstable/encoding';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

// A live, imperatively-mutable router instance. This is what `TApp` binds to: Mastra's
// `registerRoutes()` awaits ~400 sequential `registerRoute` calls against one fixed app,
// which the Layer-based `HttpRouter.add` cannot express but this service instance can.
const router: HttpRouter.HttpRouter = Effect.runSync(HttpRouter.make);

// `add` returns an Effect. With E = never and R = never it is runnable standalone, which is
// what lets `registerRoute` bridge Effect -> Promise once per route.
const registration: Effect.Effect<void, never, never> = router.add(
  'GET',
  '/probe/:id',
  (request: HttpServerRequest.HttpServerRequest) =>
    Effect.sync(() => {
      void request.url;
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }),
);

export const registerOne = (): Promise<void> => Effect.runPromise(registration);

// Streaming path: WHATWG ReadableStream -> Effect Stream -> streamed response.
export const streamResponse = (body: ReadableStream<Uint8Array>): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.stream(Stream.fromReadableStream({ evaluate: () => body, onError: () => undefined }), {
    headers: { 'content-type': 'text/event-stream' },
  });

// SSE framing is still under unstable/encoding at rc.116.
export const sseEncoder = (): unknown => Sse.encoder;

// Path params and query params, read from inside a handler.
export const readParams = Effect.gen(function* () {
  const pathParams = yield* HttpRouter.params;
  const searchParams = yield* HttpServerRequest.ParsedSearchParams;
  return { pathParams, searchParams };
});

// Two ways to drive the populated router; the adapter needs one of them for tests.
export const asEffect = () => router.asHttpEffect();
export const asWebHandler = () => HttpRouter.toWebHandler(Layer.succeed(HttpRouter.HttpRouter)(router));
