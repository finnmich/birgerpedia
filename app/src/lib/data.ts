// Build-time access to the full reviews dataset.
//
// At build time we read `../../data/processed/reviews.json` (so SSG can
// prerender review pages, generate stats, etc.). At runtime the slim
// equivalent is served from /data/reviews.json for Vue islands to fetch.
//
// IMPORTANT: we read this via `fs.readFileSync`, not `import raw from
// '...json'`. The full source dataset is 2.7 MB; making Vite transform
// that into a JS module on every dev cold-start adds ~30–60 s to the
// first page render. Reading the file with Node's fs bypasses Vite's
// transform pipeline entirely — same data, no module wrapping.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Review, ReviewIndexEntry } from './types';
import { reviewSlug } from './slug';
import { decodeEntities } from './format';
import { enrichmentFor } from './enrichment';

// Same resolution strategy as enrichment.ts — `process.cwd()` is stable
// across `astro dev` and `astro build` (it's the app/ directory both times),
// whereas `import.meta.url` shifts at build time when Astro bundles the lib.
const REVIEWS_PATH = resolve(process.cwd(), '..', 'data', 'processed', 'reviews.json');
const DROPPED_PATH = resolve(process.cwd(), 'src', '_data', 'dropped-ids.json');

// Same-day duplicate NRK article ids. Identified by sync-data.mjs via TMDB
// id collision and a placeholder-headline heuristic; see
// src/_data/dedupe-audit.json for the human-readable list of what was
// dropped and why. Filtering here means the entire SSG pipeline — review
// pages, person pages, search index, stats — sees the deduped set, not
// just the client-side index.
let _dropped: string[] = [];
try { _dropped = JSON.parse(readFileSync(DROPPED_PATH, 'utf8')); } catch {}
const _droppedSet = new Set(_dropped);

// NRK's article API leaks HTML entities into a handful of title fields
// (`God&#039;s Own Country`, `Deadpool &amp; Wolverine`, …). Decode once
// here so every downstream consumer sees the human-readable form. We
// freeze the slug against the raw (still-encoded) name so already-deployed
// URLs like /reviews/god-039-s-own-country-17230143 keep resolving.
function decodeReview(r: Review): Review & { _stableSlug: string } {
  return {
    ...backfillFactbox(r),
    _stableSlug: reviewSlug(r.name, r.id),
    name: decodeEntities(r.name),
    originalTitle: r.originalTitle ? decodeEntities(r.originalTitle) : r.originalTitle,
  };
}

// NRK's new CMS (May 2026+, /artikkel/ pages → slug ids) dropped the
// factbox entirely, so director/cast/runtime no longer exist at the NRK
// source. Backfill those from TMDB for new-CMS records only — legacy
// factboxes stay verbatim-NRK. Gated on match confidence so a wrong TMDB
// match can't inject people into credits/people pages. Mirrors
// scripts/sync-data.mjs trimReview(), which does the same for the slim
// client-side index.
function backfillFactbox(r: Review): Review {
  if (/^\d+\./.test(String(r.id))) return r;           // legacy id → untouched
  const e = enrichmentFor(r.id);
  if (!e || (e.confidence !== 'high' && e.confidence !== 'medium')) return r;
  const fb = r.factbox ?? ({} as Review['factbox']);
  return {
    ...r,
    factbox: {
      ...fb,
      regi: fb.regi ?? e.crew?.director?.name ?? null,
      serieskaper: fb.serieskaper ?? (e.crew?.creators?.length ? e.crew.creators.join(', ') : null),
      skuespillere: fb.skuespillere ?? (e.cast?.length ? e.cast.map((c) => c.name) : null),
      lengdeMinutes: fb.lengdeMinutes ?? e.runtime ?? null,
    },
  };
}

const _allReviews: Review[] = JSON.parse(readFileSync(REVIEWS_PATH, 'utf8'));
export const reviews: (Review & { _stableSlug: string })[] = _allReviews
  .filter((r) => !_droppedSet.has(r.id))
  .map(decodeReview);

function entryFor(r: Review): ReviewIndexEntry {
  const year = Number(r.publishedAt?.slice(0, 4)) || 0;
  const decade = year ? Math.floor(year / 10) * 10 : 0;
  const haystackParts: string[] = [
    r.name,
    r.headline ?? '',
    r.originalTitle ?? '',
    r.factbox?.regi ?? '',
    r.factbox?.serieskaper ?? '',
    (r.factbox?.skuespillere ?? []).join(' '),
    (r.factbox?.sjanger ?? []).join(' '),
    r.platform ?? '',
  ];
  return {
    ...r,
    year,
    decade,
    slug: (r as Review & { _stableSlug?: string })._stableSlug ?? reviewSlug(r.name, r.id),
    searchHaystack: haystackParts.join(' ').toLowerCase(),
  };
}

export const reviewIndex: ReviewIndexEntry[] = reviews
  .filter((r) => r && r.id && r.name)
  .map(entryFor)
  .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

export function findBySlug(slug: string): ReviewIndexEntry | undefined {
  return reviewIndex.find((r) => r.slug === slug);
}

// ---------- aggregate helpers ----------

export interface Counts<K extends string | number> { key: K; n: number; }

export function countBy<K extends string | number>(
  items: ReviewIndexEntry[],
  keyFn: (r: ReviewIndexEntry) => K | null | undefined,
): Counts<K>[] {
  const m = new Map<K, number>();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null || k === ('' as unknown as K)) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

export function ratingHistogram(items: ReviewIndexEntry[]): number[] {
  const out = [0, 0, 0, 0, 0, 0]; // 1..6
  for (const r of items) if (r.rating && r.rating >= 1 && r.rating <= 6) out[r.rating - 1]++;
  return out;
}

export function reviewsPerYear(items: ReviewIndexEntry[]): Counts<number>[] {
  return countBy(items, (r) => r.year).sort((a, b) => a.key - b.key);
}

export function avgRatingPerYear(items: ReviewIndexEntry[]): { year: number; avg: number; n: number }[] {
  const m = new Map<number, { sum: number; n: number }>();
  for (const r of items) {
    if (!r.year || !r.rating) continue;
    const cur = m.get(r.year) ?? { sum: 0, n: 0 };
    cur.sum += r.rating; cur.n += 1;
    m.set(r.year, cur);
  }
  return [...m.entries()]
    .map(([year, { sum, n }]) => ({ year, avg: sum / n, n }))
    .sort((a, b) => a.year - b.year);
}

export function topGenres(items: ReviewIndexEntry[], n = 20): Counts<string>[] {
  const m = new Map<string, number>();
  for (const r of items) {
    for (const g of r.factbox?.sjanger ?? []) {
      const key = g.toLowerCase().trim();
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .map(([key, count]) => ({ key, n: count }))
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}

export function topCredit(
  items: ReviewIndexEntry[],
  field: 'regi' | 'serieskaper',
  n = 20,
): Counts<string>[] {
  const m = new Map<string, number>();
  for (const r of items) {
    const v = r.factbox?.[field];
    if (!v) continue;
    // split on " og " for older articles ("Phil Lord og Christopher Miller")
    for (const name of String(v).split(/\s+og\s+/)) {
      const key = name.trim();
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .map(([key, count]) => ({ key, n: count }))
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}

export function topActors(items: ReviewIndexEntry[], n = 30): Counts<string>[] {
  const m = new Map<string, number>();
  for (const r of items) {
    for (const a of r.factbox?.skuespillere ?? []) {
      const key = a.trim();
      if (!key || key.length < 2) continue;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .map(([key, count]) => ({ key, n: count }))
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}

export function avgRatingFor(items: ReviewIndexEntry[]): number | null {
  const rated = items.filter((r) => r.rating);
  if (!rated.length) return null;
  return rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length;
}

export const SUMMARY = {
  total: reviewIndex.length,
  rated: reviewIndex.filter((r) => r.rating != null).length,
  yearMin: Math.min(...reviewIndex.map((r) => r.year || 9999)),
  yearMax: Math.max(...reviewIndex.map((r) => r.year || 0)),
  perfect6: reviewIndex.filter((r) => r.rating === 6).length,
  worst1: reviewIndex.filter((r) => r.rating === 1).length,
  movies: reviewIndex.filter((r) => r.type === 'Movie').length,
  tv: reviewIndex.filter((r) => r.type === 'TVSeries').length,
  games: reviewIndex.filter((r) => r.type === 'Game').length,
};
