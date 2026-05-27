#!/usr/bin/env node
// Refresh the TMDB `watch/providers` block for each enriched title.
//
// Why this exists: enrich-tmdb.mjs pulls watch/providers via append_to_response
// on first enrichment, but never re-fetches. Streaming availability shifts
// constantly (films leave Netflix NO, land on Max, etc.), so we need a
// recurring refresh — not just a one-shot backfill.
//
// Strategy:
//   - For each per-review enrichment JSON, look at `providersFetchedAt`
//     (set here on refresh) or fall back to `enrichedAt` (set by enrich-tmdb
//     on initial fetch). Anything older than --max-age is "stale".
//   - Records that never had a providers block at all are always eligible.
//   - Sort eligible records oldest-first and fetch up to --max of them.
//   - With ~1,800 titles and the defaults (--max-age=9d --max=200) the
//     full corpus rotates through every ~9 days, well under any TMDB cap.
//
// Usage:
//   TMDB_API_KEY=… node scripts/fetch-watch-providers.mjs
//   TMDB_API_KEY=… node scripts/fetch-watch-providers.mjs --max-age=14d --max=100
//   TMDB_API_KEY=… node scripts/fetch-watch-providers.mjs --refresh   # ignore TTL, fetch all

import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter, politeFetch, atomicWrite } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENRICH_DIR = resolve(ROOT, 'data/processed/enrichment');
const TMDB = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

const DEFAULTS = {
  maxAge: '9d',
  max: 200,
};

async function main() {
  if (!KEY) {
    console.error('ERROR: set TMDB_API_KEY');
    process.exit(2);
  }
  const refresh = process.argv.includes('--refresh');
  const maxAgeMs = parseDuration(pickArg('--max-age') ?? DEFAULTS.maxAge);
  const maxCallsArg = pickArg('--max');
  const maxCalls = maxCallsArg ? Number(maxCallsArg) : DEFAULTS.max;
  if (!Number.isFinite(maxCalls) || maxCalls <= 0) {
    console.error(`ERROR: --max must be a positive integer (got ${maxCallsArg})`);
    process.exit(2);
  }

  let files;
  try {
    files = await readdir(ENRICH_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('[providers] enrichment dir not present — nothing to refresh.');
      return;
    }
    throw e;
  }

  // First pass: enumerate eligible records (oldest-first wins).
  const now = Date.now();
  const eligible = []; // { path, ageMs, reason }
  let missed = 0, errored = 0, fresh = 0, totalSeen = 0;
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const path = resolve(ENRICH_DIR, f);
    let raw;
    try { raw = JSON.parse(await readFile(path, 'utf8')); }
    catch { errored++; continue; }
    if (raw.miss || !raw.tmdb || !raw.match?.tmdbId || !raw.match?.mediaType) {
      missed++;
      continue;
    }
    totalSeen++;

    const hasProviders = !!raw.tmdb['watch/providers'];
    const fetchedAt = raw.providersFetchedAt ?? raw.enrichedAt ?? null;
    const ageMs = fetchedAt ? (now - new Date(fetchedAt).getTime()) : Infinity;

    let reason = null;
    if (refresh) reason = 'refresh';
    else if (!hasProviders) reason = 'no-providers';
    else if (ageMs >= maxAgeMs) reason = 'stale';

    if (reason) eligible.push({ path, ageMs, reason });
    else fresh++;
  }

  eligible.sort((a, b) => b.ageMs - a.ageMs);
  const work = eligible.slice(0, maxCalls);

  const ttlStr = refresh ? 'refresh (TTL ignored)' : `TTL=${humanDuration(maxAgeMs)}`;
  console.log(
    `[providers] ${totalSeen} records (${missed} misses skipped); ` +
    `${eligible.length} eligible under ${ttlStr}, ${fresh} fresh; ` +
    `fetching ${work.length} (cap=${maxCalls}).`,
  );
  if (work.length === 0) {
    console.log('[providers] nothing to do.');
    return;
  }

  // Second pass: fetch.
  const limiter = new RateLimiter({ minIntervalMs: 250 });
  let updated = 0, withProviders = 0, fetchErrors = 0;
  for (let i = 0; i < work.length; i++) {
    const { path } = work[i];
    let raw;
    try { raw = JSON.parse(await readFile(path, 'utf8')); }
    catch { fetchErrors++; continue; }
    try {
      const url = `${TMDB}/${raw.match.mediaType}/${raw.match.tmdbId}/watch/providers?api_key=${encodeURIComponent(KEY)}`;
      const res = await politeFetch(url, { limiter, redact: KEY });
      const body = await res.json();
      raw.tmdb['watch/providers'] = body;
      raw.providersFetchedAt = new Date().toISOString();
      await atomicWrite(path, JSON.stringify(raw));
      updated++;
      if (body.results?.NO) withProviders++;
    } catch (e) {
      fetchErrors++;
      console.warn(`  [err] ${basename(path)}: ${e.message}`);
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  [${i + 1}/${work.length}] updated=${updated} (NO=${withProviders}) err=${fetchErrors}`);
    }
  }
  console.log(
    `[providers] done. updated=${updated} err=${fetchErrors}; ` +
    `${withProviders} of the refreshed records have NO providers data.`,
  );
}

// Accepts e.g. "9d", "12h", "30m", "45s". Throws on garbage.
function parseDuration(s) {
  const m = String(s).match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`bad duration ${JSON.stringify(s)} — expected like 9d, 12h, 30m, 45s`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Number(m[1]) * mult;
}

function humanDuration(ms) {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

function pickArg(name) {
  const hit = process.argv.find((x) => x.startsWith(name + '='));
  return hit ? hit.split('=', 2)[1] : null;
}

main().catch((e) => { console.error(e); process.exit(1); });
