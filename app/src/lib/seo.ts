// Absolute URLs and schema.org JSON-LD for the <head>.
//
// Crawlers and link unfurlers want absolute URLs everywhere — canonical,
// og:url, og:image, the Sitemap line in robots.txt — so everything here
// resolves against `site` from astro.config.mjs (ASTRO_SITE). Switching
// domains is then just a change of that variable.

import { u } from './url';

const SITE = import.meta.env.SITE;

// Absolute URL for an internal path (base-prefixed via `u()`) or a
// pass-through for an already-absolute one.
export function abs(path: string): string {
  return new URL(u(path), SITE).href;
}

// Canonical form of a page URL. The build writes every page as
// <path>/index.html and GH Pages 301s the slashless form to the slashed
// one, and @astrojs/sitemap lists the slashed form, so canonicals match.
export function canonicalFor(pathname: string): string {
  const p = /\/$|\.[a-z0-9]+$/i.test(pathname) ? pathname : `${pathname}/`;
  return new URL(p, SITE).href;
}

export const SITE_NAME = 'Birgerpedia';
export const DEFAULT_OG_IMAGE = '/og/home.png';

export const BIRGER = {
  '@type': 'Person',
  name: 'Birger Vestmo',
  url: 'https://www.nrk.no/forfatter/birger-vestmo-18.264',
} as const;

export const NRK = {
  '@type': 'Organization',
  name: 'NRK',
  url: 'https://www.nrk.no/',
} as const;

// schema.org type for the reviewed work. Unknown types fall back to the
// generic CreativeWork rather than guessing.
export function workType(type: string): string {
  if (type === 'Movie') return 'Movie';
  if (type === 'TVSeries') return 'TVSeries';
  if (type === 'Game' || type === 'VideoGame') return 'VideoGame';
  return 'CreativeWork';
}

export function breadcrumbs(items: Array<{ name: string; path: string }>) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: canonicalFor(u(it.path)),
    })),
  };
}

// Serialize for an inline <script type="application/ld+json">. Escaping
// `<` keeps a title like "</script>" from closing the tag early.
export function ldJson(data: object | object[]): string {
  const graph = Array.isArray(data) ? data : [data];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</g, '\\u003c');
}
