import { describe, expect, it } from 'vitest';

import { scalarPage } from './scalar.ts';

describe('scalarPage', () => {
  describe('given a spec url and title', () => {
    it('should point the reference at that spec url', async () => {
      // GIVEN a url where the OpenAPI document is served
      // WHEN the docs page is rendered
      // THEN Scalar should be told to load it
      const html = scalarPage({ specUrl: '/api/openapi.json', title: 'Mastra API' });

      expect(html).toContain('data-url="/api/openapi.json"');
      expect(html).toContain('<title>Mastra API</title>');
    });

    it('should apply the default theme and layout', async () => {
      // GIVEN no theme or layout is supplied
      // WHEN the page is rendered
      // THEN it should fall back to the same pairing used elsewhere
      const html = scalarPage({ specUrl: '/spec.json', title: 'API' });

      expect(html).toContain('kepler');
      expect(html).toContain('modern');
    });

    it('should carry an overridden theme and layout instead', async () => {
      // GIVEN an explicit theme and layout
      // WHEN the page is rendered
      // THEN those should replace the defaults
      const html = scalarPage({ specUrl: '/spec.json', title: 'API', theme: 'purple', layout: 'classic' });

      expect(html).toContain('purple');
      expect(html).toContain('classic');
      expect(html).not.toContain('kepler');
    });
  });

  describe('given values containing markup', () => {
    it('should escape a quote in the title so the attribute cannot be broken out of', async () => {
      // GIVEN a title carrying a double quote and a tag
      // WHEN the page is rendered
      // THEN the raw characters should not survive into the markup
      const html = scalarPage({ specUrl: '/spec.json', title: 'Evil" <script>alert(1)</script>' });

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&quot;');
      expect(html).toContain('&lt;script&gt;');
    });

    it('should escape a quote in the spec url', async () => {
      // GIVEN a url carrying a quote that would otherwise close the attribute
      // WHEN the page is rendered
      // THEN the attribute should remain intact
      const html = scalarPage({ specUrl: '/spec.json" data-proxy-url="http://evil', title: 'API' });

      expect(html).not.toContain('data-proxy-url="http://evil"');
      expect(html).toContain('&quot;');
    });
  });
});
