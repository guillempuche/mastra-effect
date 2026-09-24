/**
 * What reaches the app's Effect code from Mastra's side of a request.
 *
 * Mastra runs routes, tools and workflow steps as plain promises, outside the Effect request that
 * triggered them. Two things cross back: a route's server error, as a `MastraRouteError` in Effect's
 * error channel, and the request's span, which `runInRequest` hands to Effect code a tool or step
 * runs — together with the services of the app's own runtime, whose tracer makes that code's spans.
 */
import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createRoute } from '@mastra/server/server-adapter';
import { Context, Effect, Exit, Layer, ManagedRuntime, Option, Tracer } from 'effect';
import { HttpRouter } from 'effect/unstable/http';
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
      const status = tracer.spans.find(span => span.name.startsWith('http.server'))?.status;
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

const startGreeting = () =>
  new Request('http://localhost/api/workflows/greet/start-async', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    const serverSpan = tracer.spans.find(span => span.name.startsWith('http.server'));
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
    const serverSpan = tracer.spans.find(span => span.name.startsWith('http.server'));
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
