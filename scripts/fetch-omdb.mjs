#!/usr/bin/env node
// Backfill Rotten Tomatoes + Metacritic + cross-check IMDb ratings from
// OMDb (omdbapi.com).
//
// Why OMDb specifically: Rotten Tomatoes has no public API. OMDb is the
// pragmatic backdoor — it returns RT%, Metacritic, and IMDb-rating-with-vote-count
// in a single call indexed by IMDb tt-id (which we already have from TMDB).
//
// Free tier: 1,000 requests / API key / 24h. This script:
//   - Stops at MAX_PER_RUN (default 950) to leave headroom for retries.
//   - Caches per-tt-id JSON files under data/raw/omdb/, so re-runs resume
//     exactly where they left off.
//   - Polite User-Agent + 250 ms min interval (well under their cap).
//
// Output:
//   data/raw/omdb/<tt-id>.json           one file per processed title
//   data/processed/omdb-ratings.json     merged slim lookup for sync-data
//
// Usage:
//   OMDB_API_KEY=… node scripts/fetch-omdb.mjs              # backfill (resumable)
//   OMDB_API_KEY=… node scripts/fetch-omdb.mjs --limit=20   # smoke test
//   OMDB_API_KEY=… node scripts/fetch-omdb.mjs --refresh    # ignore cache

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter, politeFetch, atomicWrite, atomicWriteJson, ensureDir,
  fileExists,
} from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENR_DIR = resolve(ROOT, 'data/processed/enrichment');
// Committed aggregate of all TMDB enrichments — used as a fallback source
// of imdb ids when the gitignored per-review cache is empty (typical on
// CI cold-start). Same idea as the crawl-articles digest fallback.
const TMDB_AGGREGATE = resolve(ROOT, 'data/processed/tmdb-enrichment.json');
const OMDB_DIR = resolve(ROOT, 'data/raw/omdb');
const OUT = resolve(ROOT, 'data/processed/omdb-ratings.json');
// Same idea as crawl-articles: the slim digest committed to the repo
// already has IMDb ids we've successfully looked up before. On CI
// cold-start (empty raw/omdb cache) we use this as the skip list so we
// don't burn the daily quota re-fetching titles we already have data for.
const DIGEST = OUT;

const MAX_PER_RUN = Number(process.env.OMDB_MAX_PER_RUN ?? 950);

const argv = parseArgs(process.argv.slice(2));

async function main() {
  const KEY = process.env.OMDB_API_KEY;
  if (!KEY) {
    console.error([
      '',
      'OMDB_API_KEY not set in .env.',
      '',
      '  Step 1: visit https://www.omdbapi.com/apikey.aspx',
      '  Step 2: pick FREE tier, enter your email, submit',
      '  Step 3: click the verification link in your email',
      '  Step 4: append OMDB_API_KEY=… to /Users/finnmich/code/vestmodex/.env',
      '  Step 5: re-run this script — it will resume where it left off',
      '',
    ].join('\n'));
    process.exit(2);
  }

  await ensureDir(OMDB_DIR);

  // Skip list from the committed digest. On CI cold-start the per-id raw
  // cache is empty (gitignored), but the merged digest has every imdb id
  // we've previously turned into RT / Metacritic / IMDb-via-OMDb data.
  // Treat those as "known" so we don't re-fetch them.
  const digestIds = new Set();
  try {
    const digest = JSON.parse(await readFile(DIGEST, 'utf8'));
    for (const id of Object.keys(digest)) digestIds.add(id);
  } catch { /* fresh build, nothing committed yet */ }

  // Collect every IMDb id we need. Try the gitignored per-review cache
  // first; if empty (typical on CI cold-start, the cache is restored
  // from Actions cache and may not always be present), fall back to the
  // committed TMDB aggregate which has the same ids in a slimmer shape.
  const wanted = [];
  const seenReviewIds = new Set();
  let enrichmentFiles = [];
  try { enrichmentFiles = await readdir(ENR_DIR); } catch {}
  for (const f of enrichmentFiles) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const r = JSON.parse(await readFile(resolve(ENR_DIR, f), 'utf8'));
      const imdb = r?.tmdb?.external_ids?.imdb_id;
      if (imdb) {
        wanted.push({ reviewId: r.reviewId, imdb, name: r.name });
        seenReviewIds.add(r.reviewId);
      }
    } catch {}
  }
  let fromAggregate = 0;
  try {
    const aggregate = JSON.parse(await readFile(TMDB_AGGREGATE, 'utf8'));
    for (const [reviewId, rec] of Object.entries(aggregate)) {
      if (seenReviewIds.has(reviewId)) continue;
      const imdb = rec?.external?.imdb;
      if (imdb) {
        wanted.push({ reviewId, imdb, name: rec.title ?? '' });
        fromAggregate++;
      }
    }
  } catch { /* aggregate not present on first ever run — fine */ }
  console.log(`[omdb] ${wanted.length} ids to consider (${wanted.length - fromAggregate} from enrichment cache, ${fromAggregate} from aggregate), ${digestIds.size} already in digest`);

  const limit = argv.limit ?? wanted.length;
  const limiter = new RateLimiter({ minIntervalMs: 250 });

  let fetched = 0, cached = 0, knownDigest = 0, errored = 0, missing = 0;
  for (const w of wanted.slice(0, limit)) {
    if (fetched >= MAX_PER_RUN) {
      console.log(`[omdb] hit MAX_PER_RUN=${MAX_PER_RUN}, stopping to stay under free-tier cap. Re-run tomorrow.`);
      break;
    }
    const path = resolve(OMDB_DIR, `${w.imdb}.json`);
    if (!argv.refresh && await fileExists(path)) {
      cached++;
      continue;
    }
    if (!argv.refresh && digestIds.has(w.imdb)) {
      // Already in the merged digest — RT / Metacritic / IMDb-via-OMDb
      // are all populated from a previous run. Skip the API call.
      knownDigest++;
      continue;
    }
    try {
      const u = `https://www.omdbapi.com/?i=${encodeURIComponent(w.imdb)}&apikey=${encodeURIComponent(KEY)}&tomatoes=true`;
      // `redact: KEY` strips the API key from any retry / error log line —
      // critical in CI where Actions logs are public-readable on a 5xx flap.
      const res = await politeFetch(u, { limiter, redact: KEY });
      const body = await res.json();
      if (body.Response === 'False') {
        // OMDb returns 200 with Response=False for "Movie not found" / bad-key.
        if ((body.Error ?? '').toLowerCase().includes('invalid api key')) {
          console.error('[omdb] INVALID API KEY — aborting.');
          process.exit(3);
        }
        if ((body.Error ?? '').toLowerCase().includes('request limit')) {
          console.error('[omdb] daily request limit reached — stopping. Re-run tomorrow.');
          break;
        }
        missing++;
        await atomicWrite(path, JSON.stringify({ imdb: w.imdb, miss: true, error: body.Error ?? null }));
      } else {
        await atomicWrite(path, JSON.stringify(body));
        fetched++;
      }
    } catch (e) {
      errored++;
      console.warn(`  [err] ${w.imdb}: ${e.message}`);
    }
    if ((fetched + cached) % 50 === 0 && fetched > 0) {
      console.log(`  fetched=${fetched} cached=${cached} knownDigest=${knownDigest} miss=${missing} err=${errored}`);
    }
  }

  console.log(`[omdb] done this run. fetched=${fetched} cached=${cached} knownDigest=${knownDigest} miss=${missing} err=${errored}`);

  // Build the slim public lookup from every cache file (the result is
  // partial until backfill completes — the site renders gracefully without
  // ratings for the remainder).
  await rebuildSlimLookup();
}

async function rebuildSlimLookup() {
  const out = {};
  let withRt = 0, withMc = 0;
  for (const f of await readdir(OMDB_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(await readFile(resolve(OMDB_DIR, f), 'utf8'));
      if (o.miss) continue;
      const tt = (f.replace(/\.json$/, ''));
      const ratings = Array.isArray(o.Ratings) ? o.Ratings : [];
      const rt = ratings.find((r) => r.Source === 'Rotten Tomatoes');
      const mc = ratings.find((r) => r.Source === 'Metacritic');
      // RT comes as "67%" → 0..100; Metacritic comes as "62/100" → 0..100
      const rtPct = rt?.Value ? parseInt(String(rt.Value).replace(/%/, ''), 10) : null;
      const mcN = mc?.Value ? parseInt(String(mc.Value).split('/')[0], 10) : null;
      const imdbR = o.imdbRating && o.imdbRating !== 'N/A' ? parseFloat(o.imdbRating) : null;
      const imdbV = o.imdbVotes && o.imdbVotes !== 'N/A' ? parseInt(String(o.imdbVotes).replace(/,/g, ''), 10) : null;
      out[tt] = {
        rt: Number.isFinite(rtPct) ? rtPct : null,
        metacritic: Number.isFinite(mcN) ? mcN : null,
        imdbRating: Number.isFinite(imdbR) ? imdbR : null,
        imdbVotes: Number.isFinite(imdbV) ? imdbV : null,
        rated: o.Rated && o.Rated !== 'N/A' ? o.Rated : null,
        awards: o.Awards && o.Awards !== 'N/A' ? o.Awards : null,
      };
      if (Number.isFinite(rtPct)) withRt++;
      if (Number.isFinite(mcN)) withMc++;
    } catch {}
  }
  await atomicWriteJson(OUT, out);
  console.log(`[omdb] wrote ${OUT}: ${Object.keys(out).length} entries (${withRt} with RT, ${withMc} with Metacritic).`);
}

function parseArgs(args) {
  const out = { limit: null, refresh: false };
  for (const a of args) {
    if (a === '--refresh') out.refresh = true;
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
