import type { APIRoute } from 'astro';
import { abs } from '../lib/seo';
import { u } from '../lib/url';

// Generated rather than static so the paths carry the deploy's base
// (/birgerpedia/ on github.io) and the Sitemap line is absolute, as the
// robots.txt spec requires.
export const GET: APIRoute = () =>
  new Response(
    [
      'User-agent: *',
      'Allow: /',
      `Disallow: ${u('/random')}`,
      `Sitemap: ${abs('/sitemap-index.xml')}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
