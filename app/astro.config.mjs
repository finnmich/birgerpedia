// @ts-check
import { defineConfig } from 'astro/config';
import vue from '@astrojs/vue';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Resolve the canonical site URL. In CI we *must* know it — otherwise every
// link inside sitemap.xml, feed.xml and the OG meta tags resolves against the
// development placeholder. Local dev falls back to a placeholder; CI fails
// fast instead of silently shipping broken URLs.
const SITE = process.env.ASTRO_SITE;
if (!SITE && process.env.CI === 'true') {
  throw new Error(
    'ASTRO_SITE is not set on CI. Set it as a repo variable (Settings → ' +
    'Secrets and variables → Actions → Variables) to your final GH Pages URL ' +
    '(e.g. https://<user>.github.io/birgerpedia/ or your custom domain).',
  );
}

// Derive `base` from the site URL's pathname. GH Pages project sites live
// at /<repo>/, so deploys to https://finnmich.github.io/birgerpedia/ produce
// base = '/birgerpedia/'. Custom-domain root deploys keep base = '/'.
// Astro auto-prefixes its own emitted assets with this; for our own absolute
// paths in templates (href="/reviews/…"), use the `u()` helper in src/lib/url.ts.
let BASE = '/';
try {
  if (SITE) {
    const p = new URL(SITE).pathname;
    if (p && p !== '/') BASE = p.endsWith('/') ? p : `${p}/`;
  }
} catch { /* malformed ASTRO_SITE — fall back to '/' */ }

export default defineConfig({
  // Override at deploy time via `ASTRO_SITE` if you're on a custom domain.
  // GitHub Pages default URL is https://<user>.github.io/<repo>; set ASTRO_SITE
  // as a repo variable so the workflow's build step picks it up automatically.
  site: SITE ?? 'https://birgerpedia.local',
  base: BASE,
  integrations: [vue({ jsx: false }), sitemap()],

  vite: {
    plugins: [tailwindcss()],
  },

  // `hover` is the default. We previously set this to `viewport`, but pages
  // with many anchors (the /stats scatter has 1,693, /reviews has 1,914,
  // /timeline has thousands) caused the browser to fire off 1k+ concurrent
  // prefetch requests on load, which buries the dev server and stalls real
  // navigation. Opt selectively into viewport prefetch via
  // `data-astro-prefetch="viewport"` on individual links that benefit.
  prefetch: { defaultStrategy: 'hover', prefetchAll: false },

  build: { inlineStylesheets: 'auto' },
});
