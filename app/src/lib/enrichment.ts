// Build-time accessor for the trimmed TMDB enrichment aggregate.
//
// We read the JSON via `fs.readFileSync` (not `import enrichmentJson from
// '../_data/enrichment.json'`) because Vite would otherwise wrap the entire
// 4.4 MB JSON in a JS module on every page that imports this file — which
// adds ~30 s to cold-start for every uncached page in dev. Reading the
// file directly bypasses Vite's transform pipeline entirely.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolve relative to the project working directory, not import.meta.url —
// Astro bundles lib files into the build output, which changes the
// effective `import.meta.url`, breaking a relative path. `process.cwd()`
// stays at the app/ root in both `astro dev` and `astro build`.
const PRIMARY = resolve(process.cwd(), 'src', '_data', 'enrichment.json');
// Fallback path: if a fresh clone (or `astro build` running before
// sync-data has produced src/_data/enrichment.json) needs the data, read
// the committed snapshot directly.
const FALLBACK = resolve(process.cwd(), '..', 'data', 'processed', 'tmdb-enrichment.json');

let _map: Record<string, Enrichment> | null = null;
function load() {
  if (_map) return _map;
  for (const p of [PRIMARY, FALLBACK]) {
    try {
      _map = JSON.parse(readFileSync(p, 'utf8'));
      return _map;
    } catch { /* try next */ }
  }
  console.error('[enrichment] no enrichment data found at PRIMARY or FALLBACK');
  _map = {};
  return _map;
}

export interface CastMember {
  name: string;
  character: string | null;
  profile: string | null;
}

export interface WatchProvider {
  id: number;
  name: string;
  logo: string | null;
  priority: number;
}

export interface WatchProvidersNO {
  flatrate: WatchProvider[];
  ads: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
  link: string | null;
}

export interface Enrichment {
  miss?: boolean;
  mediaType: 'movie' | 'tv' | null;
  tmdbId: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  title: string | null;
  originalTitle: string | null;
  releaseDate: string | null;
  runtime: number | null;
  tagline: string | null;
  overview: string | null;
  genres: string[];
  keywords: string[];
  poster: string | null;
  backdrop: string | null;
  voteAverage: number | null;
  voteCount: number | null;
  popularity: number | null;
  budget: number | null;
  revenue: number | null;
  productionCompanies: string[];
  productionCountries: string[];
  spokenLanguages: string[];
  crew: {
    director: { name: string; profile: string | null } | null;
    writer: string | null;
    dop: string | null;
    composer: string | null;
    editor: string | null;
  };
  cast: CastMember[];
  external: { imdb: string | null; wikidata: string | null; instagram: string | null };
  collection: { id: number; name: string; poster: string | null } | null;
  watchProvidersNO: WatchProvidersNO | null;
}

export function enrichmentFor(reviewId: string): Enrichment | null {
  const e = load()[reviewId];
  if (!e || (e as any).miss) return null;
  return e;
}

export function allEnrichment(): Record<string, Enrichment> {
  return load();
}

export function tmdbUrl(e: Enrichment): string | null {
  if (!e.tmdbId || !e.mediaType) return null;
  return `https://www.themoviedb.org/${e.mediaType}/${e.tmdbId}`;
}

export function imdbUrl(e: Enrichment): string | null {
  return e.external?.imdb ? `https://www.imdb.com/title/${e.external.imdb}/` : null;
}
