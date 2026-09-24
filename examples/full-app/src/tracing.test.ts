import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import { NodeHttpServer } from '@effect/platform-node';
import { MastraServer, createRouter, runInRequest } from '@guillem_puche/mastra-effect';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { HttpServer } from 'effect/unstable/http';
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

const freePort = () =>
  new Promise<number>(resolve => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** Serves Mastra on a real Node server with the app's telemetry layer, exporting spans to memory. */
const serveTraced = async (mastra: Mastra) => {
  const spans = recordingExporter();
  const router = createRouter();
  await new MastraServer({ app: router, mastra }).init();

  const port = await freePort();
  const server = ManagedRuntime.make(
    HttpServer.serve()(router.asHttpEffect()).pipe(
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
      Layer.provide(telemetryLayer({ serviceName: 'tracing-test', exporters: { spans: spans.exporter, logs: new InMemoryLogRecordExporter() } })),
    ),
  );
  await server.runPromise(Effect.void);

  return {
    post: (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    const request = finished.find(span => span.name.startsWith('http.server'));
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
    const request = finished.find(span => span.name.startsWith('http.server'));
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
    const request = finished.find(span => span.name.startsWith('http.server'));
    const stepSpan = finished.find(span => span.name === 'lookup.effect');
    expect(response.status).toBe(200);
    expect(stepSpan).toBeDefined();
    expect(stepSpan?.spanContext().traceId).toBe(request?.spanContext().traceId);
    expect(stepSpan?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
  });
});
