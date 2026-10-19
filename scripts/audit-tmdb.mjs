#!/usr/bin/env node
// Re-check every existing TMDB match against the review it belongs to and
// propose corrections. Read-only: writes a report, never touches the data.
//
//   node scripts/audit-tmdb.mjs [--out=path]
//
// The report defaults to data/processed/enrichment/_audit.json: gitignored,
// and every reader of that directory skips files starting with `_`.
//
// A match passes when the NRK factbox director is among the film's TMDB
// directors, or — when the factbox has no director — when the title
// resembles the review's and the film isn't dated after the review. Every
// failing match is searched again with tmdb-matcher.mjs. Exact-title,
// same-year matches whose director disagrees are only replaced by a
// candidate whose director *does* match in the same year: the factbox has
// real errors (it credits Robin Hood 2010 to Kevin Reynolds), and those
// must not drag a correct match to a 1991 film.
//
// Proposals are reviewed by hand; the accepted ones go into
// data/tmdb-overrides.json, which enrich-tmdb.mjs and sync-data.mjs apply.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter, politeFetch, readJsonIfExists, atomicWriteJson } from './util.mjs';
import { tmdbClient, findBest, reviewContext, scoreCandidate, scoreFully, acceptable } from './tmdb-matcher.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.TMDB_API_KEY;
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? resolve(outArg.slice(6)) : resolve(ROOT, 'data/processed/enrichment/_audit.json');

if (!KEY) { console.error('ERROR: set TMDB_API_KEY'); process.exit(2); }

const reviews = JSON.parse(await readFile(resolve(ROOT, 'data/processed/reviews.json'), 'utf8'));
const snap = JSON.parse(await readFile(resolve(ROOT, 'data/processed/tmdb-enrichment.json'), 'utf8'));
const overrides = (await readJsonIfExists(resolve(ROOT, 'data/tmdb-overrides.json')))?.overrides ?? {};

const limiter = new RateLimiter({ minIntervalMs: 60 });
const client = tmdbClient({
  key: KEY,
  fetchJson: async (url) => (await politeFetch(url, { limiter, redact: KEY })).json(),
});

const asCandidate = (e) => ({
  id: e.tmdbId, mediaType: e.mediaType, title: e.title, original_title: e.originalTitle,
  release_date: e.releaseDate, popularity: e.popularity,
});
const brief = (c, s, names) => ({
  tmdbId: c.id, mediaType: c.mediaType, title: c.title ?? c.name,
  originalTitle: c.original_title ?? c.original_name, released: c.release_date ?? c.first_air_date ?? null,
  directors: names, score: s,
});

const proposals = [];
let checked = 0, passed = 0;
for (const r of reviews) {
  const e = snap[r.id];
  if (!e || e.miss || !e.tmdbId || overrides[r.id] !== undefined) continue;
  checked++;
  const ctx = reviewContext(r);
  const cur = asCandidate(e);

  if (checked % 250 === 0) console.log(`  [${checked}] passed=${passed} proposals=${proposals.length}`);

  // Cheap pass first: the snapshot already carries the first director.
  const first = e.crew?.director?.name;
  const quick = scoreCandidate(ctx, cur, first ? [first] : []);
  if (acceptable(quick) && !(ctx.regi && quick.dir !== 1)) { passed++; continue; }
  const { s, names } = await scoreFully(client, ctx, cur);
  if (acceptable(s)) { passed++; continue; }

  const best = await findBest(client, r);
  const exactCurrent = s.eligible && s.yearClose && s.title >= 0.95;
  const from = brief(cur, s, names);
  const review = { id: r.id, name: r.name, originalTitle: r.originalTitle, type: r.type, publishedAt: r.publishedAt, regi: ctx.regi, rating: r.rating };
  if (exactCurrent && !(best && best.s.dir === 1 && best.s.yearClose)) {
    proposals.push({ action: 'keep', review, from, to: best ? brief(best.c, best.s, best.names) : null });
  } else if (best && best.c.id !== cur.id) {
    proposals.push({ action: 'switch', review, from, to: brief(best.c, best.s, best.names) });
  } else {
    proposals.push({ action: 'unmatch', review, from, to: null });
  }
}

await atomicWriteJson(OUT, proposals);
const n = (a) => proposals.filter((p) => p.action === a).length;
console.log(`[audit] checked=${checked} passed=${passed} switch=${n('switch')} unmatch=${n('unmatch')} keep=${n('keep')} → ${OUT}`);
