import { randomUUID } from 'node:crypto';

// Imported by subpath, not from the barrel: the barrel re-exports WebSdk, which drags
// @opentelemetry/sdk-trace-web into a Node-only process.
import * as NodeSdk from '@effect/opentelemetry/NodeSdk';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
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
}

/**
 * OTLP export, off unless an endpoint is set.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the on/off switch, so local and cloud differ by environment
 * only — point it at otel-tui on `http://localhost:4318` in development, or at a vendor with
 * `OTEL_EXPORTER_OTLP_HEADERS` carrying the key. The exporter reads both itself.
 *
 * Returns an empty layer when unset rather than failing: telemetry is not needed to serve a
 * request, and refusing to boot over a monitoring setting turns "cannot watch" into "cannot run".
 */
export function telemetryLayer(options: TelemetryOptions): Layer.Layer<never> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return Layer.empty;

  // Logs as well as traces: the wide record above is a log line, and without a log processor it
  // would reach the backend only folded into a span as an event.
  return NodeSdk.layer(() => ({
    resource: { serviceName: options.serviceName, serviceVersion: options.serviceVersion },
    spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
    logRecordProcessor: new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
  }));
}
