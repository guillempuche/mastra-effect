/**
 * What reaches the app's Effect code from Mastra's side of a request.
 *
 * Mastra runs routes, tools and workflow steps as plain promises, outside the Effect request that
 * triggered them. Two things cross back: a route's server error, as a `MastraRouteError` in Effect's
 * error channel, and the request's trace, which `runInRequest` hands to Effect code a tool or step
 * runs — under the request's span, or the tool's or step's own when Mastra's OpenTelemetry bridge
 * opened it — together with the services of the app's own runtime, whose tracer makes that code's
 * spans.
 */
import { Mastra } from '@mastra/core';
import type { AnySpan } from '@mastra/core/observability';
import { registerApiRoute } from '@mastra/core/server';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createRoute } from '@mastra/server/server-adapter';
import { Context, Effect, Exit, Layer, ManagedRuntime, Option, Tracer } from 'effect';
import { HttpRouter } from 'effect/http';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { MastraRouteError, MastraServer, createRouter, requestSpan, runInRequest, type EffectRouter } from './index';
import { onNodeServer, type NodeServer } from './test-support';

/** A tracer that keeps every span it creates, so a test can inspect them. */
const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: options => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, layer: Layer.succeed(Tracer.Tracer)(tracer) };
};

/** Answers one request through a fetch handler with the given services, such as a tracer. */
const viaFetchHandlerWith = async (router: EffectRouter, services: Layer.Layer<never>, request: Request) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(Layer.succeed(HttpRouter.HttpRouter)(router), services),
    { disableLogger: true },
  );
  try {
    return await handler(request);
  } finally {
    await dispose();
  }
};

/** A router whose middleware records every error that reaches Effect's error channel. */
const routerWithFailingRoutes = async (options: { errorChannel?: boolean } = {}) => {
  const router = createRouter();
  const seen: unknown[] = [];
  Effect.runSync(
    router.addGlobalMiddleware(app => Effect.tapError(app, error => Effect.sync(() => seen.push(error)))),
  );
  // A custom API route's errors never reach the adapter's own catch: Mastra's sub-app answers them.
  const crashingHook = registerApiRoute('/hooks/crash', {
    method: 'GET',
    handler: async () => {
      throw new Error('hook down');
    },
  });
  const adapter = new MastraServer({
    app: router,
    mastra: new Mastra({ server: { apiRoutes: [crashingHook] } }),
    ...options,
  });
  await adapter.init();
  const register = (path: string, error: unknown) =>
    adapter.registerRoute(
      router,
      createRoute({
        method: 'GET',
        path,
        responseType: 'json',
        handler: async () => {
          throw error;
        },
      } as never),
    );
  await register('/test/crash', new Error('kaboom'));
  await register('/test/unavailable', Object.assign(new Error('upstream down'), { status: 503 }));
  await register('/test/missing', Object.assign(new Error('no such thing'), { status: 404 }));
  return { router, seen };
};

describe('a Mastra route that fails with a server error', () => {
  let node: NodeServer | undefined;
  afterEach(async () => {
    await node?.close();
    node = undefined;
  });

  it.each([
    ['/api/test/crash', 500, { error: 'kaboom' }],
    ['/api/test/unavailable', 503, { error: 'upstream down' }],
  ] as const)('should still answer %s with Mastra\'s own response, on a Node server', async (path, status, body) => {
    // GIVEN a route that throws, served the way an Effect app normally runs
    const { router } = await routerWithFailingRoutes();
    node = await onNodeServer(router);

    // WHEN it is requested
    const response = await node.send(new Request(`http://localhost${path}`));

    // THEN the client should get exactly what Mastra built, status and body
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it("should reach the app's Effect middleware as a MastraRouteError", async () => {
    // GIVEN middleware watching Effect's error channel
    const { router, seen } = await routerWithFailingRoutes();

    // WHEN a route fails with a server error
    await viaFetchHandlerWith(router, Layer.empty, new Request('http://localhost/api/test/unavailable'));

    // THEN the middleware should see it, typed, with what the route threw
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(MastraRouteError);
    expect(seen[0]).toMatchObject({ _tag: 'MastraRouteError', status: 503, message: 'upstream down' });
  });

  it("should reach Effect too when Mastra answered the failure itself, as it does a custom route's", async () => {
    // GIVEN a custom API route whose handler throws, which Mastra's own sub-app turns into a 500
    const { router, seen } = await routerWithFailingRoutes();

    // WHEN it is requested
    const response = await viaFetchHandlerWith(router, Layer.empty, new Request('http://localhost/hooks/crash'));

    // THEN the client should get Mastra's answer unchanged
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
    // AND the middleware should see a MastraRouteError naming the request, the error itself being out of reach
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ _tag: 'MastraRouteError', status: 500, message: 'Mastra answered GET /hooks/crash with 500' });
  });

  it('should leave a client error (4xx) as a normal response', async () => {
    // GIVEN the same middleware
    const { router, seen } = await routerWithFailingRoutes();

    // WHEN a route refuses a request with a 4xx
    const response = await viaFetchHandlerWith(router, Layer.empty, new Request('http://localhost/api/test/missing'));

    // THEN it is answered, and nothing reaches the error channel: a refusal is not a server failure
    expect(response.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('should mark the request span as failed when a tracer is installed', async () => {
    // GIVEN a tracer
    const { router } = await routerWithFailingRoutes();
    const tracer = recordingTracer();

    // WHEN a route fails with a server error, and its answer has been read
    const response = await viaFetchHandlerWith(router, tracer.layer, new Request('http://localhost/api/test/crash'));
    await response.text();

    // THEN the request's span should end as a failure, so tracing backends count it. It ends a moment
    // after the client has the answer, so this waits for it rather than guessing how long that takes.
    await vi.waitFor(() => {
      const status = tracer.spans.find(span => span.kind === 'server')?.status;
      expect(status !== undefined && 'exit' in status && Exit.isFailure(status.exit)).toBe(true);
    });
  });

  it('should keep the error out of Effect when errorChannel is off', async () => {
    // GIVEN an adapter told to keep route errors to itself
    const { router, seen } = await routerWithFailingRoutes({ errorChannel: false });

    // WHEN a route fails with a server error
    const response = await viaFetchHandlerWith(router, Layer.empty, new Request('http://localhost/api/test/crash'));

    // THEN the client gets the same answer, and the error channel stays empty
    expect(response.status).toBe(500);
    expect(seen).toEqual([]);
  });
});

class Greeter extends Context.Service<Greeter, { readonly greet: (name: string) => string }>()('Greeter') {}

const startGreeting = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/workflows/greet/start-async', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ inputData: { name: 'Ada' } }),
  });

const GreeterLive = Layer.succeed(Greeter)({ greet: name => `Hello from Effect, ${name}!` });

describe('runInRequest, from a workflow step', () => {
  const runtime = ManagedRuntime.make(GreeterLive);
  afterAll(() => runtime.dispose());

  /** A router whose workflow step runs Effect code through the given runtime, the app's by default. */
  const routerWithEffectStep = async (stepRuntime: ManagedRuntime.ManagedRuntime<Greeter, never> = runtime) => {
    const step = createStep({
      id: 'greet',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string(), parentSpanId: z.string().nullable() }),
      execute: context =>
        runInRequest(
          stepRuntime,
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            const parent = yield* Effect.option(Effect.currentParentSpan);
            // A span of the step's own, made by the runtime's tracer.
            const greeting = yield* Effect.withSpan(
              Effect.sync(() => greeter.greet(context.inputData.name)),
              'greet.compose',
            );
            return { greeting, parentSpanId: Option.isSome(parent) ? parent.value.spanId : null };
          }),
          context,
        ),
    });
    const workflow = createWorkflow({
      id: 'greet',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string(), parentSpanId: z.string().nullable() }),
    })
      .then(step)
      .commit();

    const router = createRouter();
    await new MastraServer({ app: router, mastra: new Mastra({ storage: new InMemoryStore(), workflows: { greet: workflow } }) }).init();
    return router;
  };

  it("should give the step the app's services, under the HTTP request's span", async () => {
    // GIVEN an app with a tracer, and a step running Effect code through the app's runtime
    const router = await routerWithEffectStep();
    const tracer = recordingTracer();

    // WHEN the workflow is started over HTTP
    const response = await viaFetchHandlerWith(router, tracer.layer, startGreeting());
    const run = (await response.json()) as { result?: { greeting: string; parentSpanId: string | null } };

    // THEN the step's Effect should have had the service, and run under the request's span
    const serverSpan = tracer.spans.find(span => span.kind === 'server');
    expect(run.result?.greeting).toBe('Hello from Effect, Ada!');
    expect(serverSpan).toBeDefined();
    expect(run.result?.parentSpanId).toBe(serverSpan?.spanId);
    // AND the server's tracer should not record the step's own span: the runtime was not given that tracer
    expect(tracer.spans.map(span => span.name)).not.toContain('greet.compose');
  });

  it("should record the step's own spans under the request's, when the runtime has the app's tracer too", async () => {
    // GIVEN a runtime built with the same tracer as the server
    const tracer = recordingTracer();
    const traced = ManagedRuntime.make(Layer.mergeAll(GreeterLive, tracer.layer));
    const router = await routerWithEffectStep(traced);

    // WHEN the workflow is started over HTTP
    const response = await viaFetchHandlerWith(router, tracer.layer, startGreeting());
    await response.json();
    await traced.dispose();

    // THEN the span the step's Effect created should be recorded, as a child of the request's span
    const serverSpan = tracer.spans.find(span => span.kind === 'server');
    const stepSpan = tracer.spans.find(span => span.name === 'greet.compose');
    expect(serverSpan).toBeDefined();
    expect(stepSpan).toBeDefined();
    expect(Option.getOrUndefined(stepSpan!.parent)?.spanId).toBe(serverSpan?.spanId);
  });

  it('should still run, with no parent span, when the app has no tracer', async () => {
    // GIVEN no tracer, so the request has no span to hand on
    const router = await routerWithEffectStep();

    // WHEN the workflow is started
    const response = await viaFetchHandlerWith(router, Layer.empty, startGreeting());
    const run = (await response.json()) as { result?: { greeting: string; parentSpanId: string | null } };

    // THEN the step should still get its service
    expect(run.result).toEqual({ greeting: 'Hello from Effect, Ada!', parentSpanId: null });
  });

  it('should find no span in a request context that never came from a request', () => {
    // GIVEN code outside any HTTP request, such as a script calling a tool directly
    // THEN there is simply no span, rather than an error
    expect(requestSpan(undefined)).toBeUndefined();
  });
});

describe("runInRequest, under the span of the tool or step running it", () => {
  const MASTRA_SPAN_ID = 'a1b2c3d4e5f60718';

  /**
   * Stands in for the span Mastra hands a tool or step. With a bridge, Mastra takes its ids from the
   * span the bridge opened in the bridge's own tracing system.
   */
  const mastraSpan = (options: { readonly traceId: string; readonly bridge?: string; readonly exportedSpanId?: string | null }) =>
    ({
      id: MASTRA_SPAN_ID,
      traceId: options.traceId,
      isValid: true,
      isInternal: false,
      getExportedSpanId: () => (options.exportedSpanId === undefined ? MASTRA_SPAN_ID : (options.exportedSpanId ?? undefined)),
      observabilityInstance: { getBridge: () => (options.bridge ? { name: options.bridge } : undefined) },
    }) as unknown as AnySpan;

  type Parent = { spanId: string; traceId: string; sampled: boolean } | null;

  /** A router whose step hands runInRequest the given Mastra span, built from the request's trace id. */
  const routerWithMastraSpan = async (span: (requestTraceId: string) => AnySpan) => {
    const runtime = ManagedRuntime.make(GreeterLive);
    const step = createStep({
      id: 'greet',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ parent: z.object({ spanId: z.string(), traceId: z.string(), sampled: z.boolean() }).nullable() }),
      execute: context =>
        runInRequest(
          runtime,
          Effect.map(Effect.option(Effect.currentParentSpan), parent => ({
            parent: Option.isSome(parent)
              ? { spanId: parent.value.spanId, traceId: parent.value.traceId, sampled: parent.value.sampled }
              : null,
          })),
          { ...context, tracingContext: { currentSpan: span(requestSpan(context.requestContext)?.traceId ?? '') } },
        ),
    });
    const workflow = createWorkflow({
      id: 'greet',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ parent: z.object({ spanId: z.string(), traceId: z.string(), sampled: z.boolean() }).nullable() }),
    })
      .then(step)
      .commit();
    const router = createRouter();
    await new MastraServer({ app: router, mastra: new Mastra({ storage: new InMemoryStore(), workflows: { greet: workflow } }) }).init();
    return router;
  };

  /** Starts the workflow with a tracer, returning the parent the step's Effect ran under and the request's span. */
  const run = async (router: EffectRouter, headers: Record<string, string> = {}) => {
    const tracer = recordingTracer();
    const response = await viaFetchHandlerWith(router, tracer.layer, startGreeting(headers));
    const body = (await response.json()) as { result?: { parent: Parent } };
    return { parent: body.result?.parent, request: tracer.spans.find(span => span.kind === 'server') };
  };

  it("should run under the tool's or step's span when OpenTelemetry's bridge opened it in the request's trace", async () => {
    // GIVEN a step whose Mastra span came from OpenTelemetry's bridge, in the request's trace
    const router = await routerWithMastraSpan(traceId => mastraSpan({ traceId, bridge: 'otel' }));

    // WHEN the workflow is started
    const { parent, request } = await run(router);

    // THEN the step's Effect should run under Mastra's span, in the same trace
    expect(parent).toEqual({ spanId: MASTRA_SPAN_ID, traceId: request?.traceId, sampled: true });
  });

  it("should keep the request's decision to drop the trace", async () => {
    // GIVEN the same step, and a caller whose trace was sampled out upstream (W3C trace flags 00)
    const router = await routerWithMastraSpan(traceId => mastraSpan({ traceId, bridge: 'otel' }));

    // WHEN the workflow is started inside that trace
    const { parent } = await run(router, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' });

    // THEN the step's Effect should run under Mastra's span, and be dropped with the rest of the trace
    expect(parent).toEqual({ spanId: MASTRA_SPAN_ID, traceId: '0af7651916cd43dd8448eb211c80319c', sampled: false });
  });

  it("should stay under the request's span when Mastra's span is in another trace", async () => {
    // GIVEN a Mastra span that the bridge started in a trace of its own, as with no context manager
    const router = await routerWithMastraSpan(() => mastraSpan({ traceId: 'ffffffffffffffffffffffffffffffff', bridge: 'otel' }));

    // WHEN the workflow is started
    const { parent, request } = await run(router);

    // THEN the step's Effect should stay under the request's span, so it stays in the request's trace
    expect(parent).toEqual({ spanId: request?.spanId, traceId: request?.traceId, sampled: true });
  });

  it("should stay under the request's span when the bridge is not OpenTelemetry's", async () => {
    // GIVEN a Mastra span from another tracing system's bridge, whose ids mean nothing to OpenTelemetry
    const router = await routerWithMastraSpan(traceId => mastraSpan({ traceId, bridge: 'datadog' }));

    // WHEN the workflow is started
    const { parent, request } = await run(router);

    // THEN the step's Effect should stay under the request's span
    expect(parent?.spanId).toBe(request?.spanId);
  });

  it("should stay under the request's span when Mastra has no bridge", async () => {
    // GIVEN a Mastra span with ids of Mastra's own making, exported through Mastra's own exporters
    const router = await routerWithMastraSpan(traceId => mastraSpan({ traceId }));

    // WHEN the workflow is started
    const { parent, request } = await run(router);

    // THEN the step's Effect should stay under the request's span
    expect(parent?.spanId).toBe(request?.spanId);
  });

  it("should run under the nearest exported span when Mastra's own span is left out of export", async () => {
    // GIVEN a Mastra span excluded from export, as internal spans are, whose parent is exported
    const router = await routerWithMastraSpan(traceId => mastraSpan({ traceId, bridge: 'otel', exportedSpanId: '0f1e2d3c4b5a6978' }));

    // WHEN the workflow is started
    const { parent } = await run(router);

    // THEN the step's Effect should run under that exported ancestor, which the trace will contain
    expect(parent?.spanId).toBe('0f1e2d3c4b5a6978');
  });

  it("should stay under the request's span when nothing of Mastra's reaches export", async () => {
    // GIVEN a Mastra span excluded from export with no exported ancestor
    const router = await routerWithMastraSpan(traceId => mastraSpan({ traceId, bridge: 'otel', exportedSpanId: null }));

    // WHEN the workflow is started
    const { parent, request } = await run(router);

    // THEN the step's Effect should stay under the request's span rather than under a span the trace lacks
    expect(parent?.spanId).toBe(request?.spanId);
  });

  it("should stay under the request's span, without failing, when the span came with nothing else", async () => {
    // GIVEN a context built by hand, as a test calling a step directly might, carrying a bare span
    const router = await routerWithMastraSpan(traceId => ({ id: MASTRA_SPAN_ID, traceId, isValid: true }) as unknown as AnySpan);

    // WHEN the workflow is started
    const { parent, request } = await run(router);

    // THEN the step should still run, under the request's span
    expect(parent?.spanId).toBe(request?.spanId);
  });
});
