#!/usr/bin/env node
// One-shot backfill: pull the watch/providers block for every already-
// enriched TMDB title and splice it into its per-review enrichment file.
//
// Why a dedicated script: enrich-tmdb.mjs now appends watch/providers on
// new lookups (so future reviews carry it for free), but the existing
// ~1800 per-review JSONs predate that change and don't have the data.
// Re-running enrich-tmdb with --refresh would re-fetch everything (cast,
// crew, keywords, …) at significant TMDB cost; this script touches only
// the providers endpoint, so it's an order of magnitude cheaper.
//
// Resumable: skips per-review JSONs that already have a watchProviders
// payload, so re-runs cost only the new arrivals.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter, politeFetch } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENRICH_DIR = resolve(ROOT, 'data/processed/enrichment');
const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

async function main() {
  if (!KEY) {
    console.error('ERROR: set TMDB_API_KEY');
    process.exit(2);
  }
  const refresh = process.argv.includes('--refresh');
  const files = await readdir(ENRICH_DIR);
  const limiter = new RateLimiter({ minIntervalMs: 250 });

  let updated = 0, skipped = 0, missed = 0, errored = 0, withProviders = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const path = resolve(ENRICH_DIR, f);
    let raw;
    try { raw = JSON.parse(await readFile(path, 'utf8')); }
    catch { errored++; continue; }

    if (raw.miss || !raw.tmdb || !raw.match?.tmdbId || !raw.match?.mediaType) {
      missed++; continue;
    }

    if (!refresh && raw.tmdb['watch/providers']) {
      skipped++;
      if (raw.tmdb['watch/providers']?.results?.NO) withProviders++;
      continue;
    }

    try {
      const url = `${TMDB}/${raw.match.mediaType}/${raw.match.tmdbId}/watch/providers?api_key=${encodeURIComponent(KEY)}`;
      const res = await politeFetch(url, { limiter, redact: KEY });
      const body = await res.json();
      raw.tmdb['watch/providers'] = body;
      await writeFile(path, JSON.stringify(raw));
      updated++;
      if (body.results?.NO) withProviders++;
    } catch (e) {
      errored++;
      console.warn(`  [err] ${f}: ${e.message}`);
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  [${i + 1}/${files.length}] updated=${updated} skipped=${skipped} miss=${missed} err=${errored}`);
    }
  }
  console.log(`[providers] done. updated=${updated} skipped=${skipped} miss=${missed} err=${errored}`);
  console.log(`[providers] ${withProviders} records now have NO providers data`);
}

main().catch((e) => { console.error(e); process.exit(1); });
