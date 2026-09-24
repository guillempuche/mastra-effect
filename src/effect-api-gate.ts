/**
 * Compile-time contract against `effect/unstable/http`. Not part of the public entry —
 * it exists so that an Effect upgrade fails `tsc` here rather than somewhere subtle at runtime.
 *
 * Pinned at effect@4.0.0-rc.117.
 */
import { Effect, Exit, Layer, type Scope, Stream } from 'effect';
import { Sse } from 'effect/unstable/encoding';
import { Cookies, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

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

// SSE framing is still under unstable/encoding at rc.117.
export const sseEncoder = (): unknown => Sse.encoder;

// Path params and query params, read from inside a handler.
export const readParams = Effect.gen(function* () {
  const pathParams = yield* HttpRouter.params;
  const searchParams = yield* HttpServerRequest.ParsedSearchParams;
  return { pathParams, searchParams };
});

// Two ways to drive the populated router; the adapter needs one of them for tests.
export const asEffect = () => router.asHttpEffect();
export const asWebHandler = () =>
  HttpRouter.toWebHandler(Layer.succeed(HttpRouter.HttpRouter)(router), { disableLogger: true });

// Cancellation: a finalizer on the request's scope sees how the request ended, and a Web request
// built by `toWeb` carries the signal it is given.
export const abortWhenInterrupted = (controller: AbortController): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(exit => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort())));
export const toWebWithSignal = (request: HttpServerRequest.HttpServerRequest, signal: AbortSignal) =>
  HttpServerRequest.toWeb(request, { signal });

// Logging a request that failed instead of answering: the response the server derives from it.
export const failedStatus = (cause: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>) =>
  Exit.isFailure(cause)
    ? Effect.map(HttpServerError.causeResponse(cause.cause), ([response]) => response.status)
    : Effect.succeed(cause.value.status);

// Set-Cookie handling: parse each header, test that it serialises, and key every cookie separately.
export const keepEveryCookie = (response: HttpServerResponse.HttpServerResponse, header: string) => {
  const parsed: Array<Cookies.Cookie> = Object.values(Cookies.fromSetCookie(header).cookies);
  const serialized: Array<string> = parsed.map(Cookies.serializeCookie);
  void serialized;
  return HttpServerResponse.replaceCookies(response, Cookies.fromReadonlyRecord({ '0:name': parsed[0]! }));
};

// Web Response in, Effect response out.
export const fromWeb = (response: Response): HttpServerResponse.HttpServerResponse => HttpServerResponse.fromWeb(response);

// The body caches `toReadableWebRequest` reads: Effect's own, on both server implementations.
export const cachedBody = (request: HttpServerRequest.HttpServerRequest) => ({
  bytes: request.arrayBuffer,
  text: request.text,
});
