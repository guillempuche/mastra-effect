import { randomUUID } from 'node:crypto';

// Imported by subpath, not from the barrel: the barrel re-exports WebSdk, which drags
// @opentelemetry/sdk-trace-web into a Node-only process.
import * as NodeSdk from '@effect/opentelemetry/NodeSdk';
import * as OtelTracer from '@effect/opentelemetry/OtelTracer';
import * as Resource from '@effect/opentelemetry/Resource';
import { SamplingStrategyType, SpanType } from '@mastra/core/observability';
import { Observability } from '@mastra/observability';
import { OtelBridge } from '@mastra/otel-bridge';
import { context, propagation, trace } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { EffectRouter } from '@guillem_puche/mastra-effect';
import { Effect, Exit, Layer } from 'effect';
import { HttpServerError, HttpServerRequest, type HttpServerResponse } from 'effect/unstable/http';

/**
 * Observability for this example, following docs/observability.md in the batuda repo.
 *
 * The rule that shapes everything here: **one wide record per unit of work**. A request closes with
 * exactly one line carrying every fact known about it, because a question can only be answered from
 * facts that share a line.
 */

/** Paths that poll constantly and say only that the poller is still polling. */
const QUIET_PATHS = new Set(['/healthz']);

/**
 * Segment shapes that are identifiers rather than route names. Collapsing them is what turns a raw
 * URL into a `http.path_pattern` that groups.
 */
const ID_SHAPES = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9A-HJKMNP-TV-Z]{26}$/, // ulid
  /^c[a-z0-9]{20,}$/i, // cuid
  /^\d+$/, // numeric id
  /^[0-9a-f]{16,}$/i, // long hex
];

/**
 * Whether a segment is an identifier rather than part of the route's name.
 *
 * The nanoid case cannot be a plain length rule: real route names get long too
 * (`background-tasks`, `observational-memory`), and collapsing one would merge unrelated routes
 * into a single meaningless bucket. Requiring digits *and* letters separates a generated id from a
 * hyphenated English name, and the route table is asserted against in the tests.
 */
function looksLikeId(segment: string): boolean {
  // `URL.pathname` keeps percent-encoding, so an address arriving as
  // `person%40example.com` would sail past a check against the raw segment and be written
  // into the record. Decode before testing; a malformed escape is left as-is.
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not valid percent-encoding — judge the raw segment instead.
  }

  // An address is personal data even when it appears as a route segment.
  if (decoded.includes('@')) return true;
  if (ID_SHAPES.some(shape => shape.test(decoded))) return true;
  return decoded.length >= 21 && /\d/.test(decoded) && /[A-Za-z]/.test(decoded);
}

/**
 * Turns a request URL into something safe to record.
 *
 * Two separate hazards. The query string can carry a single-use secret — a magic-link token, a
 * password-reset token — so it is dropped whole rather than filtered; any allowlist of safe
 * parameter names holds only until someone adds one nobody thought to name. And a path segment can
 * be an identifier or an email address, so it is collapsed to `:id`.
 *
 * Never pass a raw URL to a record. This is the only thing that should build `http.path_pattern`.
 */
export function sanitizePath(url: string): string {
  const pathname = (() => {
    try {
      return new URL(url, 'http://localhost').pathname;
    } catch {
      // Not parseable as a URL — take everything before the first query marker and no more.
      return (url.split('?')[0] ?? '').split('#')[0] ?? '';
    }
  })();

  const segments = pathname.split('/').map(segment => {
    if (segment === '') return segment;
    return looksLikeId(segment) ? ':id' : segment;
  });

  return segments.join('/') || '/';
}

/** `{domain}.{action}[.{result}]`, so a filter on one prefix gets a whole area. */
export type HttpEvent = 'http.request' | 'http.server_error' | 'http.not_found';

export function eventForStatus(status: number): HttpEvent {
  if (status >= 500) return 'http.server_error';
  if (status === 404) return 'http.not_found';
  return 'http.request';
}

/**
 * The status a request is answered with. One no route matched fails instead of producing a response,
 * so its status is asked of the failure — the way Effect's server does when it answers it.
 */
const answeredStatus = (exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>): Effect.Effect<number> =>
  Exit.isSuccess(exit)
    ? Effect.succeed(exit.value.status)
    : Effect.map(HttpServerError.causeResponse(exit.cause), ([response]) => response.status);

/**
 * Emits one record per request.
 *
 * Register this **before anything else that can answer a request itself**. Middleware that responds
 * on its own hides everything registered after it, and a refused request is exactly the one most
 * worth recording.
 *
 * A note on `http.path_pattern`: Effect's `RouteContext` carries the matched route's own pattern,
 * which would be ideal — but a global middleware sits above routing and Effect's context flows
 * downward, so the pattern is not visible from here. Hence the sanitizer.
 */
export function recordRequests(router: EffectRouter): void {
  Effect.runSync(
    router.addGlobalMiddleware(httpEffect =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, request => {
        const requestId = randomUUID();
        const pathPattern = sanitizePath(request.url);
        const started = Date.now();

        // On exit, not on success: a request no route matched fails rather than producing a
        // response, and a bot probing for `/robots.txt` still deserves its `http.not_found` record.
        return Effect.onExit(httpEffect, exit =>
          Effect.flatMap(answeredStatus(exit), status => {
            const event = eventForStatus(status);
            const record = {
              event,
              'request.id': requestId,
              'http.method': request.method,
              'http.path_pattern': pathPattern,
              'http.status': status,
              'http.duration_ms': Date.now() - started,
            };

            // A poll that went fine says only that the poller is still polling; a failing one is the
            // moment it exists for, so it keeps its usual level.
            const quiet = QUIET_PATHS.has(pathPattern) && event === 'http.request';
            const write = quiet
              ? Effect.logDebug(event)
              : event === 'http.server_error'
                ? Effect.logError(event)
                : Effect.logInfo(event);

            // Annotations, not extra log arguments. `@effect/opentelemetry`'s logger builds OTLP
            // attributes from annotations and folds message arguments into the body, so passing the
            // record as a second argument would bury every field in a string nothing can group by.
            return Effect.annotateLogs(write, record);
          }),
        );
      }),
    ),
  );
}

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /**
   * Where spans and log records go: OTLP over HTTP, configured from `OTEL_EXPORTER_OTLP_*`, unless
   * given here. Tests pass in-memory exporters.
   */
  readonly exporters?: { readonly spans: SpanExporter; readonly logs: LogRecordExporter };
}

/**
 * Whether telemetry is on. `OTEL_EXPORTER_OTLP_ENDPOINT` is the switch, so local and cloud differ by
 * environment only — point it at otel-tui on `http://localhost:4318` in development, or at a vendor
 * with `OTEL_EXPORTER_OTLP_HEADERS` carrying the key. The exporters read both themselves.
 */
export const telemetryEnabled = (): boolean => Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

/**
 * OTLP export of traces and logs, off unless enabled or given `exporters`, as tests do.
 *
 * Returns an empty layer when off rather than failing: telemetry is not needed to serve a request,
 * and refusing to boot over a monitoring setting turns "cannot watch" into "cannot run".
 *
 * The tracer provider is registered process-wide. Effect's `NodeSdk.layer` builds one without
 * registering it, and Mastra's OpenTelemetry bridge only reads the registered one — without this,
 * the bridge exports none of Mastra's spans, with no error to say so
 * (https://github.com/mastra-ai/mastra/issues/24950). Registering also installs the context manager
 * that lets Mastra's spans nest under the request's span.
 *
 * The registration is undone when the layer is released. Otherwise the process keeps the shut-down
 * provider as its global one, and OpenTelemetry refuses a second registration, so a server started
 * again in the same process — a restart in development, a second test — would export none of
 * Mastra's spans, with nothing to say so.
 */
export function telemetryLayer(options: TelemetryOptions): Layer.Layer<never> {
  if (!options.exporters && !telemetryEnabled()) return Layer.empty;

  const registerGlobally = Layer.effectDiscard(
    Effect.flatMap(Effect.service(OtelTracer.OtelTracerProvider), provider =>
      Effect.acquireRelease(
        Effect.sync(() => (provider as NodeTracerProvider).register()),
        () =>
          Effect.sync(() => {
            trace.disable();
            context.disable();
            propagation.disable();
          }),
      ),
    ),
  );

  const tracing = Layer.mergeAll(OtelTracer.layer, registerGlobally).pipe(
    Layer.provide(NodeSdk.layerTracerProvider(new BatchSpanProcessor(options.exporters?.spans ?? new OTLPTraceExporter()))),
  );

  // The wide record above is a log line: without a log processor it would reach the backend only
  // folded into a span as an event. No spanProcessor here, so this installs no second tracer.
  const logsAndResource = NodeSdk.layer(() => ({
    resource: { serviceName: options.serviceName, serviceVersion: options.serviceVersion },
    logRecordProcessor: new BatchLogRecordProcessor({ exporter: options.exporters?.logs ?? new OTLPLogExporter() }),
  }));

  return tracing.pipe(Layer.provideMerge(logsAndResource));
}

/**
 * The tracer for a runtime that `runInRequest` runs Effect code through, from a tool or a workflow
 * step.
 *
 * That code's spans are made by the runtime's tracer, not the server's. This one sends them through
 * the provider `telemetryLayer` registers, so they are exported in the request's trace, under its
 * span. Without it the runtime makes them with Effect's default tracer, which exports nothing. With
 * telemetry off, the registered provider is OpenTelemetry's no-op one, and so is this.
 *
 * ```ts
 * const runtime = ManagedRuntime.make(Layer.mergeAll(AppServicesLive, runtimeTracing('my-app')));
 * ```
 */
export const runtimeTracing = (serviceName: string): Layer.Layer<OtelTracer.OtelTracer> =>
  OtelTracer.layerGlobal.pipe(Layer.provide(Resource.layer({ serviceName })));

/**
 * Mastra's own tracing — agent runs, model calls with token counts, tool calls, workflow steps —
 * sent through the tracer provider `telemetryLayer` registers, so every one of those spans lands in
 * the same trace as the HTTP request, under its span.
 *
 * Only for when telemetry is on: the bridge does nothing without a registered provider except warn
 * on every span. Mastra samples everything here and leaves the decision to the OpenTelemetry
 * sampler, so a sampled request is never missing its agent spans. Streamed chunks are left out: one
 * span per token-sized chunk multiplies the volume without telling you anything the model span does
 * not.
 */
export function mastraObservability(serviceName: string): Observability {
  return new Observability({
    configs: {
      otel: {
        serviceName,
        bridge: new OtelBridge(),
        sampling: { type: SamplingStrategyType.ALWAYS },
        excludeSpanTypes: [SpanType.MODEL_CHUNK],
      },
    },
  });
}
