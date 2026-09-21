/**
 * Effect ships `HttpApiScalar`, but it renders an Effect `HttpApi` — it calls `OpenApi.fromApi(api)`
 * and inlines the result. Mastra's routes are not an `HttpApi`; Mastra generates its own spec and
 * serves it as an ordinary route. So the docs page points Scalar at that spec URL instead.
 *
 * Use `HttpApiScalar.layerCdn` for the app's own `HttpApi`-defined routes; the two can coexist on
 * separate paths, which is how Better Auth already serves its reference at `/auth/reference`.
 */
export interface ScalarPageOptions {
  /** Where the OpenAPI document is served, e.g. `/api/openapi.json`. */
  readonly specUrl: string;
  readonly title: string;
  readonly theme?: string;
  readonly layout?: 'modern' | 'classic';
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function scalarPage({ specUrl, title, theme = 'kepler', layout = 'modern' }: ScalarPageOptions): string {
  const config = JSON.stringify({ theme, layout });

  return `<!doctype html>
<html>
  <head>
    <title>${escapeAttribute(title)}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${escapeAttribute(specUrl)}" data-configuration="${escapeAttribute(config)}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
