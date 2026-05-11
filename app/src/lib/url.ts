// `import.meta.env.BASE_URL` is set automatically by Astro to match the
// `base` config (which we derive from ASTRO_SITE in astro.config.mjs). It
// always ends in '/'.
//
//   - Local dev:                  BASE_URL = '/'
//   - GH Pages /finnmich/birgerpedia/:  BASE_URL = '/birgerpedia/'
//   - Custom domain root deploy:  BASE_URL = '/'
//
// Always go through this helper when composing a link or fetch URL to an
// internal page or data file. External URLs (http://, https://, mailto:,
// data:) pass through unchanged so it's safe to call indiscriminately.

const BASE = import.meta.env.BASE_URL;

export function u(path: string): string {
  if (!path) return BASE;
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(path)) return path;   // already absolute/scheme
  return BASE + path.replace(/^\/+/, '');
}
