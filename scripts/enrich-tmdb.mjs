#!/usr/bin/env node
// PHASE 2 STUB — TMDB metadata enrichment.
//
// For each Birger review, look up the film/series on TMDB and store the
// result side-by-side. The crawler is intentionally idempotent so we
// can re-run it without touching NRK or replaying matches.
//
// Setup:
//   1. Get a free TMDB API key: https://www.themoviedb.org/settings/api
//   2. Export it: `export TMDB_API_KEY=…`
//   3. node scripts/enrich-tmdb.mjs --limit=20    (smoke test)
//
// Match strategy (in order — first hit wins):
//   1. originalTitle + year (most reliable for non-English films)
//   2. name + year
//   3. name (no year, take the most-popular hit, log low confidence)
//
// Output: data/processed/enrichment/<id>.json with
//   { match: { tmdbId, mediaType, confidence, query }, tmdb: {…} }
// Phase-3 build merges these into the final dataset on demand.

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter,
  politeFetch,
  atomicWriteJson,
  ensureDir,
  fileExists,
} from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWS = resolve(ROOT, 'data/processed/reviews.json');
const ENRICH_DIR = resolve(ROOT, 'data/processed/enrichment');
// Committed snapshot of the merged enrichment aggregate. Written by
// app/scripts/sync-data.mjs at build time, committed by the daily workflow.
// We read it here as a skip-list so the first CI run on a fresh repo (where
// data/processed/enrichment/ is empty by gitignore) doesn't re-enrich the
// entire corpus from TMDB.
const TMDB_SNAPSHOT = resolve(ROOT, 'data/processed/tmdb-enrichment.json');

const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

async function main() {
  if (!KEY) {
    console.error('ERROR: set TMDB_API_KEY in env. Get one at https://www.themoviedb.org/settings/api');
    process.exit(2);
  }
  await ensureDir(ENRICH_DIR);
  const reviews = JSON.parse(await readFile(REVIEWS, 'utf8'));
  const limit = arg('--limit');
  const refresh = process.argv.includes('--refresh');
  const targets = limit ? reviews.slice(0, Number(limit)) : reviews;

  // Snapshot skip-list. Misses are also recorded — we don't want to keep
  // re-asking TMDB about a film we couldn't match yesterday.
  const knownInSnapshot = new Set();
  try {
    const snap = JSON.parse(await readFile(TMDB_SNAPSHOT, 'utf8'));
    for (const id of Object.keys(snap)) knownInSnapshot.add(id);
  } catch { /* fresh project, no snapshot */ }

  // TMDB allows ~50 req/s but we keep it gentle.
  const limiter = new RateLimiter({ minIntervalMs: 250 });

  let hit = 0, miss = 0, cached = 0, knownDigest = 0, errors = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const out = resolve(ENRICH_DIR, `${r.id}.json`);
    if (!refresh && await fileExists(out)) { cached++; continue; }
    if (!refresh && knownInSnapshot.has(r.id)) { knownDigest++; continue; }

    const year = r.publishedAt?.slice(0, 4);
    const candidates = [];
    if (r.originalTitle && r.originalTitle !== r.name) {
      candidates.push({ q: r.originalTitle, year });
    }
    candidates.push({ q: r.name, year });
    candidates.push({ q: r.name }); // fallback no-year

    const wantTV = r.type === 'TVSeries';
    let match = null, tmdb = null;
    for (const c of candidates) {
      const found = await searchTmdb(c.q, c.year, wantTV, limiter);
      if (found) { match = { ...c, mediaType: wantTV ? 'tv' : 'movie' }; tmdb = found; break; }
    }
    if (!match) { miss++; await atomicWriteJson(out, { reviewId: r.id, name: r.name, miss: true }); continue; }

    // Pull richer detail (cast/crew/keywords).
    let detail = null;
    try {
      detail = await fetchTmdbDetail(tmdb.id, match.mediaType, limiter);
    } catch (e) {
      errors++;
      console.warn(`  [detail-err] ${r.id}: ${e.message}`);
    }

    await atomicWriteJson(out, {
      reviewId: r.id, name: r.name, originalTitle: r.originalTitle,
      match: { ...match, tmdbId: tmdb.id, confidence: confidenceFor(r, tmdb) },
      tmdb: detail ?? tmdb,
      enrichedAt: new Date().toISOString(),
    });
    hit++;
    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${targets.length}] hit=${hit} miss=${miss} cached=${cached} knownDigest=${knownDigest} err=${errors}`);
  }
  console.log(`\n[enrich] done. hit=${hit} miss=${miss} cached=${cached} knownDigest=${knownDigest} err=${errors}`);
}

async function searchTmdb(query, year, wantTV, limiter) {
  const path = wantTV ? '/search/tv' : '/search/movie';
  const params = new URLSearchParams({ api_key: KEY, query, language: 'nb-NO', include_adult: 'false' });
  if (year) params.set(wantTV ? 'first_air_date_year' : 'year', year);
  const res = await politeFetch(`${TMDB}${path}?${params}`, { limiter, redact: KEY });
  const json = await res.json();
  return json.results?.[0] ?? null;
}

async function fetchTmdbDetail(id, mediaType, limiter) {
  const params = new URLSearchParams({
    api_key: KEY, language: 'nb-NO',
    append_to_response: 'credits,keywords,external_ids,videos,release_dates',
  });
  const res = await politeFetch(`${TMDB}/${mediaType}/${id}?${params}`, { limiter, redact: KEY });
  return res.json();
}

function confidenceFor(review, tmdb) {
  // Trivial first cut: title-similarity-bucket + year-match. Phase-2.5
  // can replace this with Levenshtein / TMDB popularity weighting.
  const refs = [review.originalTitle, review.name].filter(Boolean).map((s) => s.toLowerCase());
  const cands = [tmdb.title, tmdb.original_title, tmdb.name, tmdb.original_name].filter(Boolean).map((s) => s.toLowerCase());
  const exact = refs.some((r) => cands.includes(r));
  const yearReview = review.publishedAt?.slice(0, 4);
  const yearTmdb = (tmdb.release_date ?? tmdb.first_air_date ?? '').slice(0, 4);
  const yearOk = yearReview && yearTmdb && Math.abs(Number(yearReview) - Number(yearTmdb)) <= 1;
  if (exact && yearOk) return 'high';
  if (exact || yearOk) return 'medium';
  return 'low';
}

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(name + '='));
  return a ? a.split('=', 2)[1] : null;
}

main().catch((e) => { console.error(e); process.exit(1); });
