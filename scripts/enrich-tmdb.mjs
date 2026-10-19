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
// Match strategy: tmdb-matcher.mjs searches both titles with and without
// the review year and ranks the hits by the NRK factbox director, then
// title, then era. data/tmdb-overrides.json pins hand-verified matches and
// wins over both the matcher and any cached result.
//
// Output: data/processed/enrichment/<id>.json with
//   { match: { tmdbId, mediaType, confidence, override? }, tmdb: {…} }
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
  readJsonIfExists,
} from './util.mjs';
import { tmdbClient, findBest, NEAR_EXACT } from './tmdb-matcher.mjs';
import { heldTmdbId } from '../app/src/lib/tmdb-match.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWS = resolve(ROOT, 'data/processed/reviews.json');
const ENRICH_DIR = resolve(ROOT, 'data/processed/enrichment');
// Committed snapshot of the merged enrichment aggregate. Written by
// app/scripts/sync-data.mjs at build time, committed by the daily workflow.
// We read it here as a skip-list so the first CI run on a fresh repo (where
// data/processed/enrichment/ is empty by gitignore) doesn't re-enrich the
// entire corpus from TMDB.
const TMDB_SNAPSHOT = resolve(ROOT, 'data/processed/tmdb-enrichment.json');
const OVERRIDES = resolve(ROOT, 'data/tmdb-overrides.json');

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
  const snap = (await readJsonIfExists(TMDB_SNAPSHOT)) ?? {};
  const overrides = (await readJsonIfExists(OVERRIDES))?.overrides ?? {};

  // TMDB allows ~50 req/s but we keep it gentle.
  const limiter = new RateLimiter({ minIntervalMs: 250 });
  const client = tmdbClient({
    key: KEY,
    fetchJson: async (url) => (await politeFetch(url, { limiter, redact: KEY })).json(),
  });

  let hit = 0, miss = 0, cached = 0, knownDigest = 0, errors = 0, games = 0, pinned = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const out = resolve(ENRICH_DIR, `${r.id}.json`);

    // A pinned match is re-fetched whenever what we hold disagrees with it:
    // the per-review cache in CI predates the pin, and the snapshot may too.
    const pin = overrides[r.id];
    if (pin) {
      const held = (await readJsonIfExists(out)) ?? snap[r.id];
      if (!refresh && held && heldTmdbId(held) === pin.tmdbId) { cached++; continue; }
      pinned++;
      if (pin.tmdbId == null) {
        await atomicWriteJson(out, { reviewId: r.id, name: r.name, miss: true, reason: 'override' });
        continue;
      }
      try {
        const detail = await fetchTmdbDetail(client, pin.tmdbId, pin.mediaType);
        await writeHit(out, r, { mediaType: pin.mediaType, tmdbId: pin.tmdbId, confidence: 'high', override: true }, detail);
      } catch (e) {
        errors++;
        console.warn(`  [override-err] ${r.id}: ${e.message}`);
      }
      continue;
    }

    if (!refresh && await fileExists(out)) { cached++; continue; }
    if (!refresh && r.id in snap) { knownDigest++; continue; }

    // TMDB indexes films and TV, not games. Searching it for a game review
    // doesn't fail cleanly — it returns a confident-looking wrong film, so
    // «DiRT3» matched "Crusty Demons of Dirt 3" and «Timeshift» matched a
    // 2015 drama called "Campus Code", each dragging a bogus poster, cast
    // and runtime onto the review page. Record a deliberate skip instead.
    if (r.type === 'Game' || r.type === 'VideoGame') {
      games++;
      await atomicWriteJson(out, { reviewId: r.id, name: r.name, miss: true, reason: 'game-not-on-tmdb' });
      continue;
    }

    const best = await findBest(client, r);
    if (!best) { miss++; await atomicWriteJson(out, { reviewId: r.id, name: r.name, miss: true }); continue; }

    // Pull richer detail (cast/crew/keywords).
    let detail = null;
    try {
      detail = await fetchTmdbDetail(client, best.c.id, best.c.mediaType);
    } catch (e) {
      errors++;
      console.warn(`  [detail-err] ${r.id}: ${e.message}`);
    }
    // 'high' when the director confirms it or the title and year both fit;
    // findBest only returns candidates that are at least plausible.
    const { s } = best;
    const confidence = s.dir === 1 || (s.title >= NEAR_EXACT && s.yearClose) ? 'high' : 'medium';
    await writeHit(out, r, { mediaType: best.c.mediaType, tmdbId: best.c.id, confidence }, detail ?? best.c);
    hit++;
    if ((i + 1) % 25 === 0) console.log(`  [${i + 1}/${targets.length}] hit=${hit} miss=${miss} games=${games} cached=${cached} knownDigest=${knownDigest} err=${errors}`);
  }
  console.log(`\n[enrich] done. hit=${hit} miss=${miss} games=${games} (skipped, not on TMDB) pinned=${pinned} cached=${cached} knownDigest=${knownDigest} err=${errors}`);
}

async function writeHit(out, r, match, tmdb) {
  const enrichedAt = new Date().toISOString();
  await atomicWriteJson(out, {
    reviewId: r.id, name: r.name, originalTitle: r.originalTitle,
    match,
    tmdb,
    enrichedAt,
    // watch/providers rides on the detail call (see append_to_response).
    // Stamp the timestamp so fetch-watch-providers.mjs's --max-age check
    // doesn't immediately re-fetch this title on the next daily run.
    providersFetchedAt: tmdb?.['watch/providers'] ? enrichedAt : null,
  });
}

function fetchTmdbDetail(client, id, mediaType) {
  return client.get(`/${mediaType}/${id}`, {
    language: 'nb-NO',
    // `watch/providers` rides on the same request — TMDB's append_to_response
    // bundles it into the detail response, no extra HTTP hop.
    append_to_response: 'credits,keywords,external_ids,videos,release_dates,watch/providers',
  });
}

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(name + '='));
  return a ? a.split('=', 2)[1] : null;
}

main().catch((e) => { console.error(e); process.exit(1); });
