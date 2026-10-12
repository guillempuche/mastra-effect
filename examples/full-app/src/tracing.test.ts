import { createServer } from 'node:http';

import { NodeHttpServer } from '@effect/platform-node';
import { MastraServer, createRouter, runInRequest } from '@guillem_puche/mastra-effect';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { SpanKind, trace } from '@opentelemetry/api';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { HttpServer } from 'effect/http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mastraObservability, runtimeTracing, telemetryLayer } from './observability.ts';

/**
 * Keeps every exported span. OpenTelemetry's own InMemorySpanExporter empties itself on shutdown,
 * which is exactly when the server flushes its last spans.
 */
const recordingExporter = () => {
  const finished: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export: (spans, done) => {
      finished.push(...spans);
      // ExportResultCode.SUCCESS, from @opentelemetry/core, which this example does not depend on.
      done({ code: 0 });
    },
    shutdown: async () => {},
  };
  return { finished, exporter };
};

/** Serves Mastra on a real Node server with the app's telemetry layer, exporting spans to memory. */
const serveTraced = async (mastra: Mastra) => {
  const spans = recordingExporter();
  const router = createRouter();
  await new MastraServer({ app: router, mastra }).init();

  // Port 0 lets the OS pick a free port as the server binds it, with no gap for another test to take it.
  const server = ManagedRuntime.make(
    HttpServer.serve()(router.asHttpEffect()).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0 })),
      Layer.provide(telemetryLayer({ serviceName: 'tracing-test', exporters: { spans: spans.exporter, logs: new InMemoryLogRecordExporter() } })),
    ),
  );
  const port = await server.runPromise(
    Effect.flatMap(Effect.service(HttpServer.HttpServer), ({ address }) =>
      'port' in address ? Effect.succeed(address.port) : Effect.die(new Error('not listening on a TCP port')),
    ),
  );

  return {
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    /** Shuts the server down, which flushes the exporters, and returns every span exported. */
    close: async () => {
      await server.dispose();
      return spans.finished;
    },
  };
};

/** Calls an agent traced through Mastra's bridge over HTTP, on a server of its own. */
const callAgent = async () => {
  const agent = new Agent({ id: 'assistant', name: 'assistant', instructions: 'x', model: createMockModel({ mockText: 'hi', version: 'v2' }) });
  const server = await serveTraced(new Mastra({ agents: { assistant: agent }, observability: mastraObservability('tracing-test') }));
  const response = await server.post('/api/agents/assistant/generate', { messages: 'hello' });
  await response.text();
  return { status: response.status, finished: await server.close() };
};

describe('tracing an agent call', () => {
  it("should put Mastra's agent span under the HTTP request's span, in one trace", async () => {
    // GIVEN the app's telemetry layer, exporting to memory, and an agent traced through Mastra's bridge
    // WHEN the agent is called over HTTP, and the server shuts down, which flushes the exporters
    const { status, finished } = await callAgent();

    // THEN the agent's span should be a child of the request's span, sharing its trace
    const request = finished.find(span => span.kind === SpanKind.SERVER);
    const agentRun = finished.find(span => span.name.startsWith('invoke_agent'));
    expect(status).toBe(200);
    expect(request).toBeDefined();
    expect(agentRun).toBeDefined();
    expect(agentRun?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(agentRun?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    // AND streamed chunks should be left out, as configured
    expect(finished.some(span => span.name.startsWith('model_chunk'))).toBe(false);
  });

  it('should keep tracing when a server is started again in the same process', async () => {
    // GIVEN a server that traced a call and was shut down, as in a restart during development
    await callAgent();

    // WHEN a new server is started in the same process and called
    const { finished } = await callAgent();

    // THEN Mastra's spans should be exported through the new server's provider, not lost to the old one
    const request = finished.find(span => span.kind === SpanKind.SERVER);
    const agentRun = finished.find(span => span.name.startsWith('invoke_agent'));
    expect(agentRun).toBeDefined();
    expect(agentRun?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
  });
});

describe('tracing Effect code a workflow step runs', () => {
  it("should export its spans in the request's trace, under the request's span", async () => {
    // GIVEN a step running Effect code through a runtime given runtimeTracing
    const runtime = ManagedRuntime.make(runtimeTracing('tracing-test'));
    const lookup = createStep({
      id: 'lookup',
      inputSchema: z.object({}),
      outputSchema: z.object({ found: z.boolean() }),
      execute: context => runInRequest(runtime, Effect.withSpan(Effect.succeed({ found: true }), 'lookup.effect'), context),
    });
    const workflow = createWorkflow({ id: 'lookup', inputSchema: z.object({}), outputSchema: z.object({ found: z.boolean() }) })
      .then(lookup)
      .commit();
    const server = await serveTraced(new Mastra({ storage: new InMemoryStore(), workflows: { lookup: workflow } }));

    // WHEN the workflow is started over HTTP, and the server shuts down, which flushes the exporters
    const response = await server.post('/api/workflows/lookup/start-async', { inputData: {} });
    await response.text();
    const finished = await server.close();
    await runtime.dispose();

    // THEN the step's own span should be exported, as a child of the request's span
    const request = finished.find(span => span.kind === SpanKind.SERVER);
    const stepSpan = finished.find(span => span.name === 'lookup.effect');
    expect(response.status).toBe(200);
    expect(stepSpan).toBeDefined();
    expect(stepSpan?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(stepSpan?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
  });
});

/**
 * A model that asks for the `lookup` tool once, then answers. Mastra's own mock model cannot call
 * tools; this speaks the AI SDK's v2 model interface directly, which is all an agent needs.
 */
const toolCallingModel = () => {
  let calls = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'tool-calling',
    supportedUrls: {},
    doGenerate: async () =>
      calls++ === 0
        ? { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }
        : { content: [{ type: 'text', text: 'found it' }], finishReason: 'stop', usage, warnings: [] },
    doStream: async () => {
      throw new Error('This test model only generates');
    },
  } as unknown as ConstructorParameters<typeof Agent>[0]['model'];
};

/** A workflow whose one step runs an Effect span through `runInRequest`, on Mastra traced through the bridge. */
const serveBridgedWorkflow = (runtime: ManagedRuntime.ManagedRuntime<never, never>) => {
  const lookup = createStep({
    id: 'lookup',
    inputSchema: z.object({}),
    outputSchema: z.object({ found: z.boolean() }),
    execute: context => runInRequest(runtime, Effect.withSpan(Effect.succeed({ found: true }), 'lookup.effect'), context),
  });
  const workflow = createWorkflow({ id: 'lookup', inputSchema: z.object({}), outputSchema: z.object({ found: z.boolean() }) })
    .then(lookup)
    .commit();
  return serveTraced(new Mastra({ storage: new InMemoryStore(), workflows: { lookup: workflow }, observability: mastraObservability('tracing-test') }));
};

/** The name of the exported span that is `span`'s parent. */
const parentName = (finished: ReadableSpan[], span: ReadableSpan | undefined) =>
  finished.find(candidate => candidate.spanContext().spanId === span?.parentSpanContext?.spanId)?.name;

describe("tracing Effect code a tool or step runs, with Mastra's spans bridged", () => {
  it("should put a workflow step's Effect span inside the step's span", async () => {
    // GIVEN a step running Effect code through runInRequest, with Mastra traced through the bridge
    const runtime = ManagedRuntime.make(runtimeTracing('tracing-test'));
    const server = await serveBridgedWorkflow(runtime);

    // WHEN the workflow is started over HTTP, and the server shuts down, which flushes the exporters
    const response = await server.post('/api/workflows/lookup/start-async', { inputData: {} });
    await response.text();
    const finished = await server.close();
    await runtime.dispose();

    // THEN the Effect span should be a child of Mastra's span for the step, in the request's trace
    const request = finished.find(span => span.kind === SpanKind.SERVER);
    const effectSpan = finished.find(span => span.name === 'lookup.effect');
    expect(response.status).toBe(200);
    expect(effectSpan?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(parentName(finished, effectSpan)).toBe('workflow_step lookup');
  });

  it("should put an agent tool's Effect span inside the tool's span", async () => {
    // GIVEN an agent whose tool runs Effect code through runInRequest, with Mastra traced through the bridge
    const runtime = ManagedRuntime.make(runtimeTracing('tracing-test'));
    const lookup = createTool({
      id: 'lookup',
      description: 'Looks something up',
      inputSchema: z.object({}),
      execute: async (_input, context) => runInRequest(runtime, Effect.withSpan(Effect.succeed({ found: true }), 'lookup.effect'), context),
    });
    const agent = new Agent({ id: 'assistant', name: 'assistant', instructions: 'x', model: toolCallingModel(), tools: { lookup } });
    const server = await serveTraced(new Mastra({ agents: { assistant: agent }, observability: mastraObservability('tracing-test') }));

    // WHEN the agent is called over HTTP and calls the tool, and the server shuts down
    const response = await server.post('/api/agents/assistant/generate', { messages: 'find it' });
    await response.text();
    const finished = await server.close();
    await runtime.dispose();

    // THEN the Effect span should be a child of Mastra's span for the tool call
    const effectSpan = finished.find(span => span.name === 'lookup.effect');
    expect(response.status).toBe(200);
    expect(effectSpan).toBeDefined();
    expect(parentName(finished, effectSpan)).toBe('execute_tool lookup');
  });

  it('should export none of its spans from a trace that was not kept', async () => {
    // GIVEN the same step, and a caller whose trace was sampled out upstream (W3C trace flags 00)
    const runtime = ManagedRuntime.make(runtimeTracing('tracing-test'));
    const server = await serveBridgedWorkflow(runtime);

    // WHEN the workflow is started inside that trace
    const response = await server.post(
      '/api/workflows/lookup/start-async',
      { inputData: {} },
      { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' },
    );
    await response.text();
    const finished = await server.close();
    await runtime.dispose();

    // THEN the Effect span should be dropped with the rest of its trace, not exported on its own
    expect(response.status).toBe(200);
    expect(finished.filter(span => span.spanContext().traceId === '0af7651916cd43dd8448eb211c80319c')).toEqual([]);
    expect(finished.map(span => span.name)).not.toContain('lookup.effect');
  });
});

describe('tracing Effect code run inside an OpenTelemetry span', () => {
  it("should join that span's trace without being given a parent", async () => {
    // GIVEN the app's telemetry layer, registering its provider and context manager
    const spans = recordingExporter();
    const telemetry = ManagedRuntime.make(
      telemetryLayer({ serviceName: 'tracing-test', exporters: { spans: spans.exporter, logs: new InMemoryLogRecordExporter() } }),
    );
    await telemetry.runPromise(Effect.void);
    const runtime = ManagedRuntime.make(runtimeTracing('tracing-test'));

    // WHEN plain code inside an active OpenTelemetry span runs an Effect span, with no Effect parent
    // Disposed even on failure: the telemetry layer registers its provider process-wide.
    const outer = await trace
      .getTracer('plain')
      .startActiveSpan('otel.outer', async span => {
        await runtime.runPromise(Effect.withSpan(Effect.void, 'effect.child'));
        span.end();
        return span;
      })
      .finally(() => runtime.dispose().then(() => telemetry.dispose()));

    // THEN the Effect span should be a child of the active span, in its trace, not the root of a new one
    // (fixed in effect 4.0.2: https://github.com/Effect-TS/effect/issues/8489)
    const child = spans.finished.find(span => span.name === 'effect.child');
    expect(child).toBeDefined();
    expect(child?.spanContext().traceId).toBe(outer.spanContext().traceId);
    expect(child?.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });
});
